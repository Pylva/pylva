"""Global LLM pricing cache (D22 parity). 24h TTL. Serves abort savings and
local budget accounting (core/budget_rules.record_llm_spend)."""

from __future__ import annotations

import asyncio
import threading
import time
from typing import Any, TypedDict

import httpx

from .config import get_config, get_config_generation

TWENTY_FOUR_HOURS_SEC = 24 * 60 * 60


class PricingEntry(TypedDict):
    provider: str
    model: str
    input_per_1m: float
    output_per_1m: float


_cache: dict[str, PricingEntry] = {}
_expires_at: float = 0.0
_refresh_lock = threading.Lock()
_refresh_in_flight = False
_refresh_token: object | None = None
_refresh_task: asyncio.Task[None] | None = None
_cache_epoch = 0
_accepted_config_generation: int | None = None


def _key(provider: str, model: str) -> str:
    return f"{provider}|{model}"


def _apply_models(
    body: Any,
    *,
    expected_epoch: int,
    expected_config_generation: int,
    expected_api_key: str,
    expected_endpoint: str,
) -> None:
    global _cache, _expires_at
    next_cache: dict[str, PricingEntry] = {}
    for m in body.get("models") or []:
        next_cache[_key(m["provider"], m["model"])] = {
            "provider": m["provider"],
            "model": m["model"],
            "input_per_1m": float(m["input_per_1m"]),
            "output_per_1m": float(m["output_per_1m"]),
        }
    current_cfg = get_config()
    current_generation = get_config_generation()
    with _refresh_lock:
        if not _context_is_current_locked(
            expected_epoch,
            expected_config_generation,
            expected_api_key,
            expected_endpoint,
            current_generation=current_generation,
            current_api_key=None if current_cfg is None else current_cfg.api_key,
            current_endpoint=None if current_cfg is None else current_cfg.endpoint,
        ):
            return
        _cache = next_cache
        _expires_at = time.time() + TWENTY_FOUR_HOURS_SEC


async def ensure_pricing_cache() -> None:
    config_generation = get_config_generation()
    cfg = get_config()
    if cfg is None:
        return
    with _refresh_lock:
        epoch = _cache_epoch
        if time.time() < _expires_at or not _local_context_is_current_locked(
            epoch, config_generation
        ):
            return
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                f"{cfg.endpoint}/api/v1/pricing",
                headers={"X-Pylva-Key": cfg.api_key},
            )
        if not resp.is_success:
            # Keep stale cache on non-ok; overgenerous TTL is fine (D22).
            return
        _apply_models(
            resp.json(),
            expected_epoch=epoch,
            expected_config_generation=config_generation,
            expected_api_key=cfg.api_key,
            expected_endpoint=cfg.endpoint,
        )
    except httpx.RequestError:
        return


def _refresh_sync() -> None:
    config_generation = get_config_generation()
    cfg = get_config()
    if cfg is None:
        return
    with _refresh_lock:
        epoch = _cache_epoch
        if time.time() < _expires_at or not _local_context_is_current_locked(
            epoch, config_generation
        ):
            return
    try:
        with httpx.Client(timeout=10.0) as client:
            resp = client.get(
                f"{cfg.endpoint}/api/v1/pricing",
                headers={"X-Pylva-Key": cfg.api_key},
            )
        if not resp.is_success:
            return
        _apply_models(
            resp.json(),
            expected_epoch=epoch,
            expected_config_generation=config_generation,
            expected_api_key=cfg.api_key,
            expected_endpoint=cfg.endpoint,
        )
    except Exception:  # R1 — a warm-up thread must never surface errors
        return


def ensure_pricing_cache_background() -> None:
    """Warm the cache without blocking the call path. Prefers a task on the
    running event loop; falls back to a daemon thread for sync hosts (parity
    with the thread-based budget sync loop). No-op while the cache is fresh
    or a refresh is already in flight."""
    global _refresh_in_flight, _refresh_task, _refresh_token
    config_generation = get_config_generation()
    with _refresh_lock:
        if (
            time.time() < _expires_at
            or _refresh_in_flight
            or not _local_context_is_current_locked(_cache_epoch, config_generation)
        ):
            return
        token = object()
        _refresh_token = token
        _refresh_in_flight = True

    def _clear() -> None:
        global _refresh_in_flight, _refresh_task, _refresh_token
        with _refresh_lock:
            if _refresh_token is token:
                _refresh_in_flight = False
                _refresh_token = None
                _refresh_task = None

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None

    if loop is not None:

        async def _run() -> None:
            try:
                await ensure_pricing_cache()
            except Exception:  # R1
                pass
            finally:
                _clear()

        task = loop.create_task(_run())
        with _refresh_lock:
            if _refresh_token is token:
                _refresh_task = task
            else:
                task.cancel()
        return

    def _run_thread() -> None:
        try:
            _refresh_sync()
        finally:
            _clear()

    threading.Thread(target=_run_thread, daemon=True, name="pylva-pricing-refresh").start()


def get_pricing(provider: str, model: str) -> PricingEntry | None:
    with _refresh_lock:
        return _cache.get(_key(provider, model))


def _context_is_current_locked(
    epoch: int,
    config_generation: int,
    api_key: str,
    endpoint: str,
    *,
    current_generation: int,
    current_api_key: str | None,
    current_endpoint: str | None,
) -> bool:
    return (
        _local_context_is_current_locked(epoch, config_generation)
        and config_generation == current_generation
        and api_key == current_api_key
        and endpoint == current_endpoint
    )


def _local_context_is_current_locked(epoch: int, config_generation: int) -> bool:
    return epoch == _cache_epoch and (
        _accepted_config_generation is None or config_generation == _accepted_config_generation
    )


def _cancel_refresh_task(task: asyncio.Task[None] | None) -> None:
    if task is None or task.done():
        return
    loop = task.get_loop()
    try:
        if loop.is_running():
            loop.call_soon_threadsafe(task.cancel)
        else:
            task.cancel()
    except RuntimeError:
        pass


def _invalidate_pricing_cache_for_config_change(
    next_config_generation: int | None = None,
) -> None:
    """Clear pricing and prevent old refreshes from populating the new tenant."""
    global _accepted_config_generation, _cache, _cache_epoch, _expires_at
    global _refresh_task
    with _refresh_lock:
        task = _refresh_task
        _refresh_task = None
        # A thread-backed refresh cannot be cancelled. Keep its token and
        # in-flight gate until its own ``finally`` runs, so rapid identity
        # switches cannot fan out concurrent TLS clients. Epoch/generation
        # checks below already make its eventual response inert.
        _cache_epoch += 1
        _accepted_config_generation = next_config_generation
        _cache = {}
        _expires_at = 0.0
    _cancel_refresh_task(task)


def _reset_pricing_cache_for_tests() -> None:
    global _accepted_config_generation, _cache, _cache_epoch, _expires_at
    global _refresh_in_flight, _refresh_task, _refresh_token
    with _refresh_lock:
        task = _refresh_task
        _refresh_task = None
        _refresh_token = None
        _refresh_in_flight = False
        _cache_epoch += 1
        _accepted_config_generation = None
        _cache = {}
        _expires_at = 0.0
    _cancel_refresh_task(task)


def _set_pricing_for_tests(entries: list[PricingEntry], ttl_sec: float = 3600.0) -> None:
    """Seed the cache directly (tests only) — avoids HTTP in unit tests."""
    global _cache, _expires_at
    with _refresh_lock:
        _cache = {_key(e["provider"], e["model"]): e for e in entries}
        _expires_at = time.time() + ttl_sec
