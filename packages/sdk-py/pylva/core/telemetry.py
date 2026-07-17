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
import threading
import uuid
from collections import OrderedDict
from datetime import datetime, timezone
from typing import Any

import httpx

from .._version import SDK_VERSION
from .budget_accumulator import mark_exceeded_from_backend
from .budget_rules import record_llm_spend
from .config import _require_config_snapshot, get_config, get_config_generation

logger = logging.getLogger("pylva")

BUFFER_CAP = 10_000
LRU_CAP = 10_000
RETRY_DELAYS_SEC = (1.0, 2.0, 4.0)
SCHEMA_VERSION = "1.6"


class _State:
    def __init__(self, generation: int) -> None:
        self.generation = generation
        self.retired = False
        self.buffer: list[dict[str, Any]] = []
        self.sent_span_ids: OrderedDict[str, None] = OrderedDict()
        self.sent_count = 0
        self.degraded = False
        self.warned_overflow = False
        self.warned_estimated_usage = False
        self.warned_unknown: set[str] = set()
        self.flush_task: asyncio.Task[None] | None = None
        self.sleeping_flush_task: asyncio.Task[None] | None = None


_state_lock = threading.RLock()
_state = _State(get_config_generation())


def enqueue(event: dict[str, Any]) -> None:
    """Add one event to the buffer. Silently drops if degraded."""
    generation = get_config_generation()
    with _state_lock:
        state = _state
        if state.generation != generation or state.retired or state.degraded:
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
        expected_config_generation=generation,
    )

    meta = full.get("metadata") or {}
    with _state_lock:
        # A builder switch may have completed while local pricing ran. Never
        # append that old event to the new builder's state.
        if _state is not state or state.retired or state.generation != generation:
            return
        if (
            isinstance(meta, dict)
            and meta.get("token_count_source") == "estimated"
            and not state.warned_estimated_usage
        ):
            state.warned_estimated_usage = True
            print(
                "[pylva] token counts estimated from stream chunks; "
                "upgrade `ai` to >=3.3 for exact counts",
                flush=True,
            )
        if len(state.buffer) >= BUFFER_CAP:
            if not state.warned_overflow:
                state.warned_overflow = True
                print(
                    f"[pylva] local buffer full ({BUFFER_CAP} events) — "
                    "dropping oldest. Backend unreachable since start.",
                    flush=True,
                )
            state.buffer.pop(0)
        state.buffer.append(full)
    _schedule_flush(state)


def _schedule_flush(state: _State | None = None) -> None:
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
    current = _state if state is None else state
    if current is not _state or current.retired:
        return
    task = current.flush_task
    # A pending task only counts if it belongs to THIS loop — a task left
    # behind by a closed loop (sequential asyncio.run() calls) never
    # completes and would block scheduling forever.
    if task is not None and not task.done() and task.get_loop() is loop:
        if len(current.buffer) < cfg.batch_size:
            return
        if current.sleeping_flush_task is not task:
            return
        task.cancel()
    current.flush_task = loop.create_task(_flush_loop(current))


async def _flush_loop(state: _State | None = None) -> None:
    """Drain the buffer, then exit; the next enqueue restarts the loop.
    Flushes immediately while a full batch is waiting, otherwise after
    flush_interval. Exits when a flush makes no progress (backend down →
    flush() re-queues the batch and already slept its retry schedule); the
    backlog is retried on the next enqueue or the atexit drain."""
    current = _state if state is None else state
    try:
        while current.buffer and not current.degraded and not current.retired:
            cfg = get_config()
            if cfg is None:
                return
            if len(current.buffer) < cfg.batch_size:
                sleep_task = asyncio.current_task()
                current.sleeping_flush_task = sleep_task
                try:
                    await asyncio.sleep(cfg.flush_interval)
                finally:
                    if current.sleeping_flush_task is sleep_task:
                        current.sleeping_flush_task = None
                if not current.buffer or current.degraded or current.retired:
                    return
            before = len(current.buffer)
            sent_before = current.sent_count
            await _flush_state(current)
            if (
                current.buffer
                and len(current.buffer) >= before
                and current.sent_count == sent_before
            ):
                return
    finally:
        task = asyncio.current_task()
        if current.sleeping_flush_task is task:
            current.sleeping_flush_task = None
        if current.flush_task is task:
            current.flush_task = None


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
    await _flush_state(_state)


async def _flush_state(state: _State) -> None:
    while state.buffer and not state.degraded and not state.retired:
        before = len(state.buffer)
        sent_before = state.sent_count
        await _flush_once(state)
        if state.buffer and len(state.buffer) >= before and state.sent_count == sent_before:
            return


async def _flush_once(state: _State | None = None) -> None:
    """Send one batch from the head of the buffer."""
    current = _state if state is None else state
    if current.degraded or current.retired:
        return
    try:
        cfg, generation = _require_config_snapshot()
    except RuntimeError:
        return
    if current.generation != generation:
        return
    if cfg.local_mode:
        current.buffer.clear()
        return
    if not current.buffer:
        return

    take = min(len(current.buffer), cfg.batch_size)
    batch = current.buffer[:take]
    current.buffer = current.buffer[take:]

    new_batch = [ev for ev in batch if ev["span_id"] not in current.sent_span_ids]
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
                if current.retired:
                    return
                if response.status_code == 401:
                    _enter_degraded(current)
                    return
                if response.status_code >= 500:
                    last_error = f"HTTP {response.status_code}"
                    if attempt < len(RETRY_DELAYS_SEC):
                        await asyncio.sleep(RETRY_DELAYS_SEC[attempt])
                        continue
                break
            except httpx.RequestError as err:
                if current.retired:
                    return
                last_error = str(err)
                if attempt < len(RETRY_DELAYS_SEC):
                    await asyncio.sleep(RETRY_DELAYS_SEC[attempt])
                    continue
                break

    if current.retired:
        return

    if response is None or response.status_code >= 500:
        current.buffer = new_batch + current.buffer
        if len(current.buffer) > BUFFER_CAP:
            drop = len(current.buffer) - BUFFER_CAP
            current.buffer = current.buffer[drop:]
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
        _record_sent(ev["span_id"], current)

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
            if key not in current.warned_unknown:
                current.warned_unknown.add(key)
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
            expected_config_generation=generation,
        )


def _enter_degraded(state: _State | None = None) -> None:
    current = _state if state is None else state
    if current.retired:
        return
    current.degraded = True
    current.buffer.clear()
    print(
        "[pylva] API key was rejected. Check it at "
        "https://pylva.com/settings/keys. "
        "Telemetry is now disabled for this process.",
        flush=True,
    )


def _record_sent(span_id: str, state: _State | None = None) -> None:
    current = _state if state is None else state
    if current.retired:
        return
    if span_id in current.sent_span_ids:
        return
    current.sent_span_ids[span_id] = None
    current.sent_count += 1
    while len(current.sent_span_ids) > LRU_CAP:
        current.sent_span_ids.popitem(last=False)


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _reset_telemetry_for_tests() -> None:
    _prepare_configuration_change(get_config_generation(), emit_diagnostic=False)


def _prepare_configuration_change(
    next_config_generation: int,
    *,
    emit_diagnostic: bool = True,
) -> None:
    """Retire the current exporter before a new builder identity is installed."""

    global _state
    with _state_lock:
        old_state = _state
        old_state.retired = True
        dropped = len(old_state.buffer)
        old_state.buffer.clear()
        tasks = {old_state.flush_task, old_state.sleeping_flush_task}
        _state = _State(next_config_generation)
    for task in tasks:
        if task is None or task.done():
            continue
        loop = task.get_loop()
        if loop.is_closed():
            continue
        if loop.is_running():
            loop.call_soon_threadsafe(task.cancel)
        else:
            task.cancel()
    if emit_diagnostic and dropped:
        logger.warning(
            "[pylva] discarded %d buffered telemetry event(s) after builder identity changed",
            dropped,
        )
