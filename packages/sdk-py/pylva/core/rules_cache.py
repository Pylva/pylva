"""Rules cache — prep only in B1 (fetch + TTL + passthrough). B4-T1 adds eval."""

from __future__ import annotations

import asyncio
import threading
import time
from typing import Any

import httpx

from .._version import API_CONTRACT_VERSION
from .config import get_config, get_config_generation

# PR #70 follow-up — 60s per remaining-implementation-plan.md O25
# (was 300s; plan tightened to keep newly-activated rules reaching SDKs
# in <1 min). A failed refresh may retain the last successful list for
# diagnostics/recovery, but _passthrough=True prevents that stale snapshot
# from affecting routing, failover, or budget decisions.
RULES_CACHE_TTL_SEC = 60

_rules: list[Any] = []
_fetched_at: float = 0.0
_passthrough: bool = False
_warned_passthrough: bool = False
_in_flight: asyncio.Task[None] | None = None
_cache_lock = threading.Lock()
_cache_epoch = 0
_accepted_config_generation: int | None = None


async def ensure_rules_cache() -> None:
    global _in_flight, _passthrough
    config_generation = get_config_generation()
    cfg = get_config()
    if cfg is None:
        return
    loop = asyncio.get_running_loop()
    with _cache_lock:
        epoch = _cache_epoch
        if not _local_context_is_current_locked(epoch, config_generation):
            return
        age = time.time() - _fetched_at
        if age < RULES_CACHE_TTL_SEC and not _passthrough:
            return
        # Provider wrappers schedule this coroutine without awaiting it. Mark
        # an expired snapshot unusable before the HTTP refresh can yield.
        if age >= RULES_CACHE_TTL_SEC:
            _passthrough = True
        task = _in_flight
        if task is not None and not task.done():
            if task.get_loop() is not loop:
                # A refresh in another event loop will update the shared cache.
                # Awaiting it here would raise a cross-loop RuntimeError.
                return
        else:
            task = asyncio.create_task(
                _refresh(
                    age,
                    epoch=epoch,
                    config_generation=config_generation,
                    api_key=cfg.api_key,
                    endpoint=cfg.endpoint,
                )
            )
            _in_flight = task
    try:
        await task
    except asyncio.CancelledError:
        with _cache_lock:
            invalidated = epoch != _cache_epoch
        if not invalidated:
            raise
    finally:
        with _cache_lock:
            if _in_flight is task:
                _in_flight = None


async def _refresh(
    age: float,
    *,
    epoch: int,
    config_generation: int,
    api_key: str,
    endpoint: str,
) -> None:
    global _rules, _fetched_at, _passthrough, _warned_passthrough
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                f"{endpoint}/api/v1/rules",
                headers={
                    "X-Pylva-Key": api_key,
                    "X-Pylva-Contract-Version": API_CONTRACT_VERSION,
                },
            )
        if not resp.is_success:
            current_cfg = get_config()
            current_generation = get_config_generation()
            with _cache_lock:
                if not _context_is_current_locked(
                    epoch,
                    config_generation,
                    api_key,
                    endpoint,
                    current_generation=current_generation,
                    current_api_key=None if current_cfg is None else current_cfg.api_key,
                    current_endpoint=None if current_cfg is None else current_cfg.endpoint,
                ):
                    return
                # 401/403 is definitive for this identity. In particular, a
                # suspended workspace must not retain warmed routing/failover
                # rules while the SDK is in passthrough mode.
                if resp.status_code in (401, 403):
                    _rules = []
                if not _warned_passthrough:
                    print(
                        "[pylva] rules cache stale — backend returned non-ok; passthrough mode",
                        flush=True,
                    )
                    _warned_passthrough = True
                _passthrough = True
            return
        try:
            body = resp.json()
        except (TypeError, ValueError):
            current_cfg = get_config()
            current_generation = get_config_generation()
            with _cache_lock:
                if not _context_is_current_locked(
                    epoch,
                    config_generation,
                    api_key,
                    endpoint,
                    current_generation=current_generation,
                    current_api_key=None if current_cfg is None else current_cfg.api_key,
                    current_endpoint=None if current_cfg is None else current_cfg.endpoint,
                ):
                    return
                if not _warned_passthrough:
                    print(
                        "[pylva] rules cache stale — backend returned malformed rules; "
                        "passthrough mode",
                        flush=True,
                    )
                    _warned_passthrough = True
                _passthrough = True
            return
        next_rules = body.get("rules") if isinstance(body, dict) else None
        current_cfg = get_config()
        current_generation = get_config_generation()
        with _cache_lock:
            if not _context_is_current_locked(
                epoch,
                config_generation,
                api_key,
                endpoint,
                current_generation=current_generation,
                current_api_key=None if current_cfg is None else current_cfg.api_key,
                current_endpoint=None if current_cfg is None else current_cfg.endpoint,
            ):
                return
            if not isinstance(next_rules, list):
                if not _warned_passthrough:
                    print(
                        "[pylva] rules cache stale — backend returned malformed rules; "
                        "passthrough mode",
                        flush=True,
                    )
                    _warned_passthrough = True
                _passthrough = True
                return
            _rules = next_rules
            _fetched_at = time.time()
            _passthrough = False
            _warned_passthrough = False
    except httpx.RequestError:
        current_cfg = get_config()
        current_generation = get_config_generation()
        with _cache_lock:
            if not _context_is_current_locked(
                epoch,
                config_generation,
                api_key,
                endpoint,
                current_generation=current_generation,
                current_api_key=None if current_cfg is None else current_cfg.api_key,
                current_endpoint=None if current_cfg is None else current_cfg.endpoint,
            ):
                return
            if age > RULES_CACHE_TTL_SEC and not _warned_passthrough:
                print(
                    "[pylva] rules cache stale — passthrough mode (backend unreachable > 60s)",
                    flush=True,
                )
                _warned_passthrough = True
            _passthrough = True


def is_passthrough() -> bool:
    return _passthrough


def get_cached_rules() -> list[Any]:
    return _rules


def get_rules_for_evaluation() -> list[Any]:
    """Return an atomic, fail-open snapshot for provider-call evaluation."""
    with _cache_lock:
        stale = time.time() - _fetched_at >= RULES_CACHE_TTL_SEC
        return [] if _passthrough or stale else list(_rules)


def mark_stale_rules_passthrough() -> None:
    """Synchronously quarantine an expired cache before scheduling refresh."""
    global _passthrough
    with _cache_lock:
        if time.time() - _fetched_at >= RULES_CACHE_TTL_SEC:
            _passthrough = True


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
        and current_api_key == api_key
        and current_endpoint == endpoint
    )


def _local_context_is_current_locked(epoch: int, config_generation: int) -> bool:
    return epoch == _cache_epoch and (
        _accepted_config_generation is None or config_generation == _accepted_config_generation
    )


def _cancel_task(task: asyncio.Task[None] | None) -> None:
    if task is None or task.done():
        return
    loop = task.get_loop()
    try:
        if loop.is_running():
            loop.call_soon_threadsafe(task.cancel)
        else:
            task.cancel()
    except RuntimeError:
        # A concurrently-closing loop already made the task inert.
        pass


def _invalidate_rules_cache_for_config_change(
    next_config_generation: int | None = None,
) -> None:
    """Clear builder rules and make late old-identity responses no-ops."""
    global _accepted_config_generation, _cache_epoch, _fetched_at, _in_flight
    global _passthrough, _rules, _warned_passthrough
    with _cache_lock:
        task = _in_flight
        _in_flight = None
        _cache_epoch += 1
        _accepted_config_generation = next_config_generation
        _rules = []
        _fetched_at = 0.0
        _passthrough = False
        _warned_passthrough = False
    _cancel_task(task)


def _reset_rules_cache_for_tests() -> None:
    global _accepted_config_generation, _cache_epoch, _fetched_at, _in_flight
    global _passthrough, _rules, _warned_passthrough
    with _cache_lock:
        task = _in_flight
        _in_flight = None
        _cache_epoch += 1
        _accepted_config_generation = None
        _rules = []
        _fetched_at = 0.0
        _passthrough = False
        _warned_passthrough = False
    _cancel_task(task)


def _mark_rules_cache_fresh_for_tests() -> None:
    """Mark directly injected test rules as a freshly fetched snapshot."""
    global _fetched_at, _passthrough
    with _cache_lock:
        _fetched_at = time.time()
        _passthrough = False
