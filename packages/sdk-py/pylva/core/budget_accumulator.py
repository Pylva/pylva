"""B2a — SDK-side budget accumulator (Python parity with TS).

Per-process dict keyed on ``{rule_id}:{scope_token}:{period_start}`` with LRU
eviction at 50,000 entries. Threading primitives (Lock + Timer) keep the
accumulator safe under concurrent wrapper calls without forcing asyncio.
"""

from __future__ import annotations

import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Literal

import httpx

from .config import get_config

LRU_MAX = 50_000
SYNC_INTERVAL_SEC = 5 * 60
# The backend accepts at most 500 entries per /budget/sync request. Split large
# per-customer snapshots so one builder crossing that limit does not disable
# reconciliation for every accumulator entry.
SYNC_BATCH_SIZE = 500

Scope = Literal["per_customer", "pooled"]
Period = Literal["hour", "day", "week", "month"]


@dataclass
class AccumulatorEntry:
    total_usd: float = 0.0
    event_count: int = 0
    last_touched: float = 0.0
    exceeded_source: Literal["backend_ingest_flag"] | None = None


@dataclass(frozen=True)
class AccumulatorKey:
    rule_id: str
    scope: Scope
    customer_id: str | None
    period_start: str


# OrderedDict preserves insertion order for LRU semantics.
_accum: OrderedDict[str, AccumulatorEntry] = OrderedDict()
_lock = threading.Lock()
_sync_timer: threading.Timer | None = None
_lru_warned_at: float = 0.0
_sync_missing_period_start_warned: bool = False
_sync_ambiguous_period_start_warned: bool = False


def _canonical_period_start(period_start: str) -> str:
    """Return JS Date.toISOString()-style UTC milliseconds, or the original string.

    Period strings are part of the accumulator key, so Python's
    `...00Z` and the backend/TS `...00.000Z` must collapse to one key.
    """
    try:
        normalized = period_start[:-1] + "+00:00" if period_start.endswith("Z") else period_start
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return period_start
    if parsed.tzinfo is None:
        return period_start

    utc = parsed.astimezone(timezone.utc)
    milliseconds = utc.microsecond // 1000
    utc = utc.replace(microsecond=milliseconds * 1000)
    return f"{utc:%Y-%m-%dT%H:%M:%S}.{milliseconds:03d}Z"


def _key_of(k: AccumulatorKey) -> str | None:
    if k.scope == "pooled":
        return f"{k.rule_id}:__pooled__:{_canonical_period_start(k.period_start)}"
    # per_customer with no customer identity has no valid key. Callers treat
    # None as "skip" — collapsing to the pooled token here made per-customer
    # hard stops silently unenforceable for calls without a customer context
    # (events attribute those to 'anonymous', so the tokens never matched).
    if not k.customer_id:
        return None
    return f"{k.rule_id}:{k.customer_id}:{_canonical_period_start(k.period_start)}"


def _touch(key: str, entry: AccumulatorEntry) -> None:
    _accum.move_to_end(key)
    entry.last_touched = time.time()


def _maybe_evict() -> None:
    global _lru_warned_at
    if len(_accum) <= LRU_MAX:
        return
    overflow = len(_accum) - LRU_MAX
    for _ in range(overflow):
        _accum.popitem(last=False)
    now = time.time()
    if now - _lru_warned_at > 5 * 60:
        _lru_warned_at = now
        print(
            f"[pylva] budget accumulator LRU-evicted {overflow} entries (cap {LRU_MAX})",
            flush=True,
        )


def _ensure(key: str) -> AccumulatorEntry:
    entry = _accum.get(key)
    if entry is None:
        entry = AccumulatorEntry(total_usd=0.0, event_count=0, last_touched=time.time())
        _accum[key] = entry
        _maybe_evict()
    return entry


def get(k: AccumulatorKey) -> AccumulatorEntry:
    """Read the accumulator entry for a key (or a zeroed one if absent)."""
    key = _key_of(k)
    if key is None:
        return AccumulatorEntry()
    with _lock:
        entry = _accum.get(key)
        return entry if entry is not None else AccumulatorEntry()


def add(k: AccumulatorKey, actual_usd: float) -> None:
    """Bump the accumulator after a successful LLM call."""
    if actual_usd is None or actual_usd < 0:
        return
    key = _key_of(k)
    if key is None:
        return
    with _lock:
        entry = _ensure(key)
        entry.total_usd += actual_usd
        entry.event_count += 1
        _touch(key, entry)


def mark_exceeded_from_backend(
    *, rule_id: str, customer_id: str | None, limit_usd: float, period_start: str
) -> None:
    """Backend ingest flagged this key as exceeded — bump local to limit+1."""
    k = AccumulatorKey(
        rule_id=rule_id,
        scope="pooled" if customer_id is None else "per_customer",
        customer_id=customer_id,
        period_start=period_start,
    )
    key = _key_of(k)
    if key is None:
        return
    with _lock:
        entry = _ensure(key)
        entry.total_usd = max(entry.total_usd, limit_usd + 1)
        entry.exceeded_source = "backend_ingest_flag"
        _touch(key, entry)


def set_from_sync(k: AccumulatorKey, server_total_usd: float) -> None:
    """Replace local total with the server truth (I-T3-3 overwrite semantics)."""
    if server_total_usd is None or server_total_usd < 0:
        return
    key = _key_of(k)
    if key is None:
        return
    with _lock:
        entry = _ensure(key)
        entry.total_usd = server_total_usd
        entry.exceeded_source = None
        _touch(key, entry)


@dataclass(frozen=True)
class PreCallCheckResult:
    over_limit: bool
    accumulated_usd: float
    projected_usd: float
    source: Literal["backend_ingest_flag"] | None = None


def check(
    *,
    rule_id: str,
    scope: Scope,
    customer_id: str | None,
    period_start: str,
    estimated_usd: float,
    limit_usd: float,
) -> PreCallCheckResult:
    """Non-throwing pre-call check. Wrapper decides whether to throw or warn."""
    key = _key_of(AccumulatorKey(rule_id, scope, customer_id, period_start))
    entry: AccumulatorEntry | None = None
    if key is not None:
        with _lock:
            entry = _accum.get(key)
            # LRU-touch on read: an actively-blocking key must not be evicted
            # just because nothing writes to it anymore (writes stop once
            # calls block).
            if entry is not None:
                _touch(key, entry)
    accumulated = entry.total_usd if entry is not None else 0.0
    projected = accumulated + (estimated_usd if estimated_usd > 0 else 0.0)
    return PreCallCheckResult(
        # >= matches the server (computeBudgetExceededFlags / budget sync both
        # flag at total >= limit) so spend exactly at the limit blocks on both
        # sides of the contract.
        over_limit=projected >= limit_usd,
        accumulated_usd=accumulated,
        projected_usd=projected,
        source=entry.exceeded_source if entry is not None else None,
    )


def start_sync_loop() -> None:
    """Start the 5-minute sync loop. Idempotent."""
    global _sync_timer
    if _sync_timer is not None:
        return

    def tick() -> None:
        try:
            run_sync_now()
        except Exception:  # R1 — never crash the host process
            pass
        finally:
            _schedule_next()

    def _schedule_next() -> None:
        global _sync_timer
        _sync_timer = threading.Timer(SYNC_INTERVAL_SEC, tick)
        _sync_timer.daemon = True
        _sync_timer.start()

    _schedule_next()


def stop_sync_loop() -> None:
    global _sync_timer
    if _sync_timer is not None:
        _sync_timer.cancel()
        _sync_timer = None


def _warn_missing_period_start_fallback() -> None:
    global _sync_missing_period_start_warned
    if _sync_missing_period_start_warned:
        return
    _sync_missing_period_start_warned = True
    print(
        "[pylva] /budget/sync response is missing period_start; "
        "falling back to an unambiguous legacy match",
        flush=True,
    )


def _warn_ambiguous_period_start_skip() -> None:
    global _sync_ambiguous_period_start_warned
    if _sync_ambiguous_period_start_warned:
        return
    _sync_ambiguous_period_start_warned = True
    print(
        "[pylva] /budget/sync response is missing period_start for "
        "multiple local periods; skipping ambiguous reconciliation",
        flush=True,
    )


def _matching_sync_snapshot(
    snapshot: list[dict[str, object]],
    response_entry: dict[str, object],
) -> dict[str, object] | None:
    tuple_matches = [
        s
        for s in snapshot
        if s["rule_id"] == response_entry.get("rule_id")
        and s["scope"] == response_entry.get("scope")
        and s["customer_id"] == response_entry.get("customer_id")
    ]
    response_period_start = response_entry.get("period_start")
    if isinstance(response_period_start, str):
        canonical_response_period_start = _canonical_period_start(response_period_start)
        return next(
            (s for s in tuple_matches if s["period_start"] == canonical_response_period_start),
            None,
        )
    if len(tuple_matches) == 1:
        _warn_missing_period_start_fallback()
        return tuple_matches[0]
    if len(tuple_matches) > 1:
        _warn_ambiguous_period_start_skip()
    return None


def run_sync_now() -> None:
    """POST current accumulator state to /api/v1/budget/sync, overwrite local."""
    cfg = get_config()
    if cfg is None:
        return
    with _lock:
        if not _accum:
            return
        snapshot: list[dict[str, object]] = []
        for composite, entry in _accum.items():
            rule_id, scope_token, period_start = composite.split(":", 2)
            scope: Scope = "pooled" if scope_token == "__pooled__" else "per_customer"
            customer_id = None if scope == "pooled" else scope_token
            snapshot.append(
                {
                    "rule_id": rule_id,
                    "scope": scope,
                    "customer_id": customer_id,
                    "accumulated_cost_usd": entry.total_usd,
                    "period_start": period_start,
                    "event_count": entry.event_count,
                }
            )

    try:
        with httpx.Client(timeout=10.0) as client:
            for offset in range(0, len(snapshot), SYNC_BATCH_SIZE):
                batch = snapshot[offset : offset + SYNC_BATCH_SIZE]
                try:
                    resp = client.post(
                        f"{cfg.endpoint}/api/v1/budget/sync",
                        headers={"X-Pylva-Key": cfg.api_key, "Content-Type": "application/json"},
                        json={"entries": batch},
                    )
                    if not resp.is_success:
                        continue
                    body = resp.json()
                    entries = body.get("entries", [])
                except httpx.RequestError:
                    # A transport failure applies to the endpoint, not one
                    # malformed batch. Stop so synchronous init cannot turn
                    # one outage into up to 100 sequential timeout waits.
                    return

                for r in entries:
                    snap = _matching_sync_snapshot(batch, r)
                    if snap is None:
                        continue
                    snap_period_start = snap["period_start"]
                    if not isinstance(snap_period_start, str):
                        continue
                    set_from_sync(
                        AccumulatorKey(
                            rule_id=r["rule_id"],
                            scope=r["scope"],
                            customer_id=r["customer_id"],
                            period_start=snap_period_start,
                        ),
                        r["server_total_usd"],
                    )
    except httpx.RequestError:
        return


def init_accumulator() -> None:
    """Prime the accumulator on SDK init. Non-blocking enough for a host that
    imports pylva and immediately makes calls — first call falls through
    passthrough if backend is unreachable."""
    start_sync_loop()
    try:
        run_sync_now()
    except Exception:
        pass


def _reset_accumulator_for_tests() -> None:
    global _lru_warned_at, _sync_missing_period_start_warned, _sync_ambiguous_period_start_warned
    with _lock:
        _accum.clear()
        _lru_warned_at = 0.0
        _sync_missing_period_start_warned = False
        _sync_ambiguous_period_start_warned = False
    stop_sync_loop()
