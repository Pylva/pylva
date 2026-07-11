"""Buffered telemetry exporter (D1, D6, D19, D32 parity with TS).

Flush scheduling mirrors the TS exporter: ``enqueue()`` lazy-starts a
background drain task on the running event loop — immediate when the
buffer reaches ``batch_size``, otherwise after ``flush_interval``. The
task exits once the buffer drains and is restarted by the next enqueue.
Sync hosts with no event loop fall back to the atexit drain; they can
also call ``asyncio.run(pylva.flush())`` explicitly.
"""

from __future__ import annotations

import asyncio
import atexit
import json
import logging
import uuid
from collections import OrderedDict
from datetime import datetime, timezone
from typing import Any

import httpx

from .budget_accumulator import mark_exceeded_from_backend
from .budget_rules import record_llm_spend
from .config import get_config

logger = logging.getLogger("pylva")

BUFFER_CAP = 10_000
LRU_CAP = 10_000
RETRY_DELAYS_SEC = (1.0, 2.0, 4.0)
SCHEMA_VERSION = "1.6"
SDK_VERSION = "1.1.0"


class _State:
    def __init__(self) -> None:
        self.buffer: list[dict[str, Any]] = []
        self.sent_span_ids: OrderedDict[str, None] = OrderedDict()
        self.sent_count = 0
        self.degraded = False
        self.warned_overflow = False
        self.warned_estimated_usage = False
        self.warned_unknown: set[str] = set()
        self.flush_task: asyncio.Task[None] | None = None
        self.sleeping_flush_task: asyncio.Task[None] | None = None


_state = _State()


def enqueue(event: dict[str, Any]) -> None:
    """Add one event to the buffer. Silently drops if degraded."""
    if _state.degraded:
        return

    full = dict(event)
    full["schema_version"] = SCHEMA_VERSION
    full["sdk_version"] = SDK_VERSION

    # Local budget accounting: bump every applicable budget rule's accumulator
    # with this call's cost so pre-call hard stops react in-process instead of
    # waiting for the backend flag / 5-min sync. Token-based like server-side
    # pricing; zero-token (failure) and non-LLM events no-op inside.
    record_llm_spend(
        customer_id=full.get("customer_id"),
        provider=full.get("provider"),
        model=full.get("model"),
        tokens_in=full.get("tokens_in") or 0,
        tokens_out=full.get("tokens_out") or 0,
    )

    meta = full.get("metadata") or {}
    if (
        isinstance(meta, dict)
        and meta.get("token_count_source") == "estimated"
        and not _state.warned_estimated_usage
    ):
        _state.warned_estimated_usage = True
        print(
            "[pylva] token counts estimated from stream chunks; "
            "upgrade `ai` to >=3.3 for exact counts",
            flush=True,
        )

    if len(_state.buffer) >= BUFFER_CAP:
        if not _state.warned_overflow:
            _state.warned_overflow = True
            print(
                f"[pylva] local buffer full ({BUFFER_CAP} events) — "
                "dropping oldest. Backend unreachable since start.",
                flush=True,
            )
        _state.buffer.pop(0)
    _state.buffer.append(full)
    _schedule_flush()


def _schedule_flush() -> None:
    """Lazy-start the background drain task (TS parity: enqueue triggers a
    flush at batch_size, otherwise the interval timer picks it up). No-op
    for sync hosts without a running loop — the atexit drain is their
    backstop."""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    cfg = get_config()
    if cfg is None:
        return  # not initialized — don't churn no-op tasks per enqueue
    task = _state.flush_task
    # A pending task only counts if it belongs to THIS loop — a task left
    # behind by a closed loop (sequential asyncio.run() calls) never
    # completes and would block scheduling forever.
    if task is not None and not task.done() and task.get_loop() is loop:
        if len(_state.buffer) < cfg.batch_size:
            return
        if _state.sleeping_flush_task is not task:
            return
        task.cancel()
    _state.flush_task = loop.create_task(_flush_loop())


async def _flush_loop() -> None:
    """Drain the buffer, then exit; the next enqueue restarts the loop.
    Flushes immediately while a full batch is waiting, otherwise after
    flush_interval. Exits when a flush makes no progress (backend down →
    flush() re-queues the batch and already slept its retry schedule); the
    backlog is retried on the next enqueue or the atexit drain."""
    try:
        while _state.buffer and not _state.degraded:
            cfg = get_config()
            if cfg is None:
                return
            if len(_state.buffer) < cfg.batch_size:
                sleep_task = asyncio.current_task()
                _state.sleeping_flush_task = sleep_task
                try:
                    await asyncio.sleep(cfg.flush_interval)
                finally:
                    if _state.sleeping_flush_task is sleep_task:
                        _state.sleeping_flush_task = None
                if not _state.buffer or _state.degraded:
                    return
            before = len(_state.buffer)
            sent_before = _state.sent_count
            await flush()
            if (
                _state.buffer
                and len(_state.buffer) >= before
                and _state.sent_count == sent_before
            ):
                return
    finally:
        task = asyncio.current_task()
        if _state.sleeping_flush_task is task:
            _state.sleeping_flush_task = None
        if _state.flush_task is task:
            _state.flush_task = None


def _drain_at_exit() -> None:
    """Best-effort flush of buffered events at interpreter exit (parity with
    the TS `beforeExit` hook). Only runs when no event loop is active —
    asyncio.run() cannot nest. Bounded: stops as soon as a flush makes no
    progress so a dead backend can't hang shutdown indefinitely."""
    if _state.degraded or not _state.buffer:
        return
    try:
        asyncio.get_running_loop()
        return
    except RuntimeError:
        pass
    try:
        while _state.buffer and not _state.degraded:
            before = len(_state.buffer)
            asyncio.run(flush())
            if len(_state.buffer) >= before:
                break
    except Exception:
        pass  # R1 — never let telemetry shutdown raise


atexit.register(_drain_at_exit)


def buffer_size() -> int:
    return len(_state.buffer)


def is_degraded() -> bool:
    return _state.degraded


async def flush() -> None:
    """Drain buffered telemetry. Idempotent on empty buffer."""
    while _state.buffer and not _state.degraded:
        before = len(_state.buffer)
        sent_before = _state.sent_count
        await _flush_once()
        if (
            _state.buffer
            and len(_state.buffer) >= before
            and _state.sent_count == sent_before
        ):
            return


async def _flush_once() -> None:
    """Send one batch from the head of the buffer."""
    if _state.degraded:
        return
    cfg = get_config()
    if cfg is None:
        return
    if cfg.local_mode:
        _state.buffer.clear()
        return
    if not _state.buffer:
        return

    take = min(len(_state.buffer), cfg.batch_size)
    batch = _state.buffer[:take]
    _state.buffer = _state.buffer[take:]

    new_batch = [ev for ev in batch if ev["span_id"] not in _state.sent_span_ids]
    if not new_batch:
        return

    body = {
        "batch_id": str(uuid.uuid4()),
        "sdk_version": SDK_VERSION,
        "events": new_batch,
    }
    last_error: str | None = None
    response: httpx.Response | None = None

    async with httpx.AsyncClient(timeout=10.0) as client:
        for attempt in range(len(RETRY_DELAYS_SEC) + 1):
            try:
                response = await client.post(
                    f"{cfg.endpoint}/api/v1/events",
                    headers={
                        "content-type": "application/json",
                        "X-Pylva-Key": cfg.api_key,
                    },
                    content=json.dumps(body),
                )
                if response.status_code == 401:
                    _enter_degraded()
                    return
                if response.status_code >= 500:
                    last_error = f"HTTP {response.status_code}"
                    if attempt < len(RETRY_DELAYS_SEC):
                        await asyncio.sleep(RETRY_DELAYS_SEC[attempt])
                        continue
                break
            except httpx.RequestError as err:
                last_error = str(err)
                if attempt < len(RETRY_DELAYS_SEC):
                    await asyncio.sleep(RETRY_DELAYS_SEC[attempt])
                    continue
                break

    if response is None or response.status_code >= 500:
        _state.buffer = new_batch + _state.buffer
        if len(_state.buffer) > BUFFER_CAP:
            drop = len(_state.buffer) - BUFFER_CAP
            _state.buffer = _state.buffer[drop:]
        print(f"[pylva] flush failed after retries: {last_error or 'unknown'}", flush=True)
        return

    if not response.is_success:
        print(f"[pylva] flush rejected: HTTP {response.status_code}", flush=True)
        return

    try:
        parsed = response.json()
    except Exception:
        return

    for ev in new_batch:
        _record_sent(ev["span_id"])

    for e in parsed.get("errors") or []:
        idx = e.get("index")
        span_id = (
            new_batch[idx]["span_id"] if isinstance(idx, int) and idx < len(new_batch) else "?"
        )
        print(f"[pylva] event rejected: {e.get('message')} (span_id={span_id})", flush=True)

    for w in parsed.get("warnings") or []:
        code = w.get("code")
        if code in ("needs_pricing_input", "pending_pricing"):
            if w.get("metric"):
                key = f"metric:{w['metric']}"
            else:
                key = f"llm:{w.get('provider') or ''}:{w.get('model') or ''}"
            if key not in _state.warned_unknown:
                _state.warned_unknown.add(key)
                print(
                    f"[pylva] pricing not yet configured for {key} — "
                    "cost will be backfilled once you add it in the dashboard",
                    flush=True,
                )

    for flag in parsed.get("budget_exceeded") or []:
        if not isinstance(flag, dict):
            continue
        rule_id = flag.get("rule_id")
        period_start = flag.get("period_start")
        limit_usd = flag.get("limit_usd")
        if not isinstance(rule_id, str) or not isinstance(period_start, str):
            continue
        if not isinstance(limit_usd, int | float):
            continue
        mark_exceeded_from_backend(
            rule_id=rule_id,
            customer_id=flag.get("customer_id")
            if isinstance(flag.get("customer_id"), str)
            else None,
            limit_usd=float(limit_usd),
            period_start=period_start,
        )


def _enter_degraded() -> None:
    _state.degraded = True
    _state.buffer.clear()
    print(
        "[pylva] API key was rejected. Check it at "
        "https://pylva.com/settings/keys. "
        "Telemetry is now disabled for this process.",
        flush=True,
    )


def _record_sent(span_id: str) -> None:
    if span_id in _state.sent_span_ids:
        return
    _state.sent_span_ids[span_id] = None
    _state.sent_count += 1
    while len(_state.sent_span_ids) > LRU_CAP:
        _state.sent_span_ids.popitem(last=False)


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _reset_telemetry_for_tests() -> None:
    global _state
    _state = _State()
