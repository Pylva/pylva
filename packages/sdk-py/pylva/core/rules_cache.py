"""Rules cache — prep only in B1 (fetch + TTL + passthrough). B4-T1 adds eval."""

from __future__ import annotations

import asyncio
import time
from typing import Any

import httpx

from .config import get_config

# PR #70 follow-up — 60s per remaining-implementation-plan.md O25
# (was 300s; plan tightened to keep newly-activated rules reaching SDKs
# in <1 min). Stale-serve semantics unchanged: on fetch error past TTL
# we keep the last successful rules list and flip _passthrough=True so
# the engine fails open.
RULES_CACHE_TTL_SEC = 60

_rules: list[Any] = []
_fetched_at: float = 0.0
_passthrough: bool = False
_warned_passthrough: bool = False
_in_flight: asyncio.Task[None] | None = None


async def ensure_rules_cache() -> None:
    global _in_flight
    age = time.time() - _fetched_at
    if age < RULES_CACHE_TTL_SEC and not _passthrough:
        return
    if _in_flight is not None and not _in_flight.done():
        await _in_flight
        return
    _in_flight = asyncio.create_task(_refresh(age))
    try:
        await _in_flight
    finally:
        _in_flight = None


async def _refresh(age: float) -> None:
    global _rules, _fetched_at, _passthrough, _warned_passthrough
    cfg = get_config()
    if cfg is None:
        return

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                f"{cfg.endpoint}/api/v1/rules",
                headers={"X-Pylva-Key": cfg.api_key},
            )
        if not resp.is_success:
            if not _warned_passthrough:
                print(
                    "[pylva] rules cache stale — backend returned non-ok; passthrough mode",
                    flush=True,
                )
                _warned_passthrough = True
            _passthrough = True
            return
        body = resp.json()
        rules = body.get("rules") if isinstance(body, dict) else None
        if not isinstance(rules, list):
            if not _warned_passthrough:
                print(
                    "[pylva] rules cache stale — backend returned malformed rules; "
                    "passthrough mode",
                    flush=True,
                )
            _warned_passthrough = True
            _passthrough = True
            return
        _rules = rules
        _fetched_at = time.time()
        _passthrough = False
        _warned_passthrough = False
    except Exception:
        # R1: JSON decoding and response-shape failures are SDK failures just
        # like transport errors. They must never escape a background refresh.
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


def _reset_rules_cache_for_tests() -> None:
    global _rules, _fetched_at, _passthrough, _warned_passthrough, _in_flight
    _rules = []
    _fetched_at = 0.0
    _passthrough = False
    _warned_passthrough = False
    _in_flight = None
