"""Global LLM pricing cache (D22 parity). 24h TTL. Serves abort savings and
local budget accounting (core/budget_rules.record_llm_spend)."""

from __future__ import annotations

import asyncio
import threading
import time
from typing import Any, TypedDict

import httpx

from .config import get_config

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


def _key(provider: str, model: str) -> str:
    return f"{provider}|{model}"


def _apply_models(body: Any) -> None:
    global _cache, _expires_at
    next_cache: dict[str, PricingEntry] = {}
    for m in body.get("models") or []:
        next_cache[_key(m["provider"], m["model"])] = {
            "provider": m["provider"],
            "model": m["model"],
            "input_per_1m": float(m["input_per_1m"]),
            "output_per_1m": float(m["output_per_1m"]),
        }
    _cache = next_cache
    _expires_at = time.time() + TWENTY_FOUR_HOURS_SEC


async def ensure_pricing_cache() -> None:
    if time.time() < _expires_at:
        return
    cfg = get_config()
    if cfg is None:
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
        _apply_models(resp.json())
    except httpx.RequestError:
        return


def _refresh_sync() -> None:
    cfg = get_config()
    if cfg is None:
        return
    try:
        with httpx.Client(timeout=10.0) as client:
            resp = client.get(
                f"{cfg.endpoint}/api/v1/pricing",
                headers={"X-Pylva-Key": cfg.api_key},
            )
        if not resp.is_success:
            return
        _apply_models(resp.json())
    except Exception:  # R1 — a warm-up thread must never surface errors
        return


def ensure_pricing_cache_background() -> None:
    """Warm the cache without blocking the call path. Prefers a task on the
    running event loop; falls back to a daemon thread for sync hosts (parity
    with the thread-based budget sync loop). No-op while the cache is fresh
    or a refresh is already in flight."""
    global _refresh_in_flight
    if time.time() < _expires_at:
        return
    with _refresh_lock:
        if _refresh_in_flight:
            return
        _refresh_in_flight = True

    def _clear() -> None:
        global _refresh_in_flight
        with _refresh_lock:
            _refresh_in_flight = False

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

        loop.create_task(_run())
        return

    def _run_thread() -> None:
        try:
            _refresh_sync()
        finally:
            _clear()

    threading.Thread(target=_run_thread, daemon=True, name="pylva-pricing-refresh").start()


def get_pricing(provider: str, model: str) -> PricingEntry | None:
    return _cache.get(_key(provider, model))


def _reset_pricing_cache_for_tests() -> None:
    global _cache, _expires_at, _refresh_in_flight
    _cache = {}
    _expires_at = 0.0
    with _refresh_lock:
        _refresh_in_flight = False


def _set_pricing_for_tests(entries: list[PricingEntry], ttl_sec: float = 3600.0) -> None:
    """Seed the cache directly (tests only) — avoids HTTP in unit tests."""
    global _cache, _expires_at
    _cache = {_key(e["provider"], e["model"]): e for e in entries}
    _expires_at = time.time() + ttl_sec
