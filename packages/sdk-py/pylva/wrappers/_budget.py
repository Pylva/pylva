"""B2a — shared pre-call budget hook for Python wrappers (parity with TS)."""

from __future__ import annotations

import asyncio
import time
from datetime import datetime

from ..core.budget_accumulator import check
from ..core.budget_rules import find_applicable_budget_rules, period_start_utc
from ..core.rules_cache import get_cached_rules, is_passthrough
from ..errors.budget_exceeded import BudgetExceededSource, PylvaBudgetExceeded

Period = str
Scope = str

_advisory_log: dict[str, float] = {}


def _period_start_utc(period: Period, at: datetime | None = None) -> str:
    """Back-compat alias — the implementation moved to core/budget_rules."""
    return period_start_utc(period, at)


def _advisory_warn(rule_id: str, projected: float, limit: float) -> None:
    now = time.time()
    last = _advisory_log.get(rule_id, 0.0)
    if now - last < 60:
        return
    _advisory_log[rule_id] = now
    print(
        f"[pylva] advisory: rule {rule_id} projected ${projected:.2f} vs limit ${limit:.2f}",
        flush=True,
    )


def _schedule_rules_refresh() -> None:
    """Fire-and-forget the rules cache refresh so we don't block the call path.
    Reuses ``refresh_and_validate_once`` from `_init_validation` so the D52
    failover-wrapper validation runs at most once per process even if init()
    ran without an event loop."""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return  # No running loop: skip; the next event-loop turn will refresh.
    from ._init_validation import refresh_and_validate_once

    loop.create_task(refresh_and_validate_once())


def maybe_enforce_pre_call(*, customer_id: str | None, estimated_usd: float) -> None:
    """Raise PylvaBudgetExceeded on hard-stop violation. Passthrough-safe.

    Enforces EVERY applicable budget rule (parity with the server's
    computeBudgetExceededFlags AND-semantics): the strictest rule wins; a
    customer-specific cap is never shadowed by a newer global rule.
    """
    _schedule_rules_refresh()

    if is_passthrough():
        return

    for match in find_applicable_budget_rules(get_cached_rules(), customer_id):
        period_start = period_start_utc(match["period"])
        result = check(
            rule_id=match["rule_id"],
            scope=match["scope"],
            customer_id=match["scope_token_customer_id"],
            period_start=period_start,
            estimated_usd=estimated_usd,
            limit_usd=match["limit_usd"],
        )
        if not result.over_limit:
            continue

        if match["hard_stop"]:
            source = (
                BudgetExceededSource.BACKEND_INGEST_FLAG
                if result.source == BudgetExceededSource.BACKEND_INGEST_FLAG.value
                else BudgetExceededSource.SDK_PRECALL
            )
            raise PylvaBudgetExceeded(
                source=source,
                rule_id=match["rule_id"],
                customer_id=match["scope_token_customer_id"],
                period=match["period"],
                period_start=period_start,
                limit_usd=match["limit_usd"],
                accumulated_usd=result.accumulated_usd,
                estimated_usd=estimated_usd,
            )

        _advisory_warn(match["rule_id"], result.projected_usd, match["limit_usd"])
