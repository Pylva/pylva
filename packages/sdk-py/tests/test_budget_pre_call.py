"""Budget-limit hard-block coverage for maybe_enforce_pre_call."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from pylva.core import budget_accumulator as ba
from pylva.core import rules_cache
from pylva.errors.budget_exceeded import BudgetExceededSource, PylvaBudgetExceeded
from pylva.wrappers._budget import _period_start_utc, maybe_enforce_pre_call


def setup_function(_fn: object) -> None:
    rules_cache._reset_rules_cache_for_tests()  # type: ignore[attr-defined]
    ba._reset_accumulator_for_tests()  # type: ignore[attr-defined]


def test_stale_customer_throttle_rule_is_ignored() -> None:
    rules_cache._rules.append(  # type: ignore[attr-defined]
        {
            "id": "stale-throttle",
            "type": "customer_throttle",
            "enabled": True,
            "customer_id": "cust_1",
            "config": {"trigger": "manual", "throttled": True},
        }
    )

    maybe_enforce_pre_call(customer_id="cust_1", estimated_usd=0.05)


def test_backend_budget_flag_surfaces_backend_ingest_source() -> None:
    rules_cache._rules.append(  # type: ignore[attr-defined]
        {
            "id": "budget-1",
            "type": "budget_limit",
            "enabled": True,
            "customer_id": "cust_1",
            "config": {
                "limit_usd": 10,
                "period": "day",
                "hard_stop": True,
                "scope": "per_customer",
            },
        }
    )
    period_start = _period_start_utc("day")
    ba.mark_exceeded_from_backend(
        rule_id="budget-1",
        customer_id="cust_1",
        limit_usd=10,
        period_start=period_start,
    )

    with pytest.raises(PylvaBudgetExceeded) as info:
        maybe_enforce_pre_call(customer_id="cust_1", estimated_usd=0)
    assert info.value.source == BudgetExceededSource.BACKEND_INGEST_FLAG


@pytest.mark.parametrize(
    ("at", "expected"),
    [
        # Wed/Thu/Fri whose ISO-week Monday lives in the previous month.
        (datetime(2026, 7, 1, 12, tzinfo=timezone.utc), "2026-06-29T00:00:00.000Z"),
        (datetime(2026, 7, 2, 9, tzinfo=timezone.utc), "2026-06-29T00:00:00.000Z"),
        (datetime(2026, 7, 3, 23, tzinfo=timezone.utc), "2026-06-29T00:00:00.000Z"),
        # Sunday whose Monday is in the previous month (and year).
        (datetime(2026, 2, 1, 6, tzinfo=timezone.utc), "2026-01-26T00:00:00.000Z"),
        (datetime(2027, 1, 2, 6, tzinfo=timezone.utc), "2026-12-28T00:00:00.000Z"),
        # Within-month sanity checks.
        (datetime(2026, 6, 30, 12, tzinfo=timezone.utc), "2026-06-29T00:00:00.000Z"),
        (datetime(2026, 3, 2, 0, tzinfo=timezone.utc), "2026-03-02T00:00:00.000Z"),
    ],
)
def test_period_start_week_crosses_month_boundary(at: datetime, expected: str) -> None:
    assert _period_start_utc("week", at) == expected
