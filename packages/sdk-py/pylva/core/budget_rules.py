"""Budget-rule matching, period math, and local spend recording shared by the
pre-call hook (wrappers/_budget) and the telemetry exporter (core/telemetry).

Lives in core/ so telemetry can record spend without importing wrapper code.
Parity with the TS SDK's core/budget_rules.ts.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from .budget_accumulator import AccumulatorKey, _canonical_period_start, add
from .pricing_cache import ensure_pricing_cache_background, get_pricing
from .rules_cache import get_cached_rules, is_passthrough

RULE_TYPE_BUDGET_LIMIT = "budget_limit"


def narrow_rule(raw: Any) -> dict[str, Any] | None:
    """Defensively narrow a cached rule (the cache stores untyped JSON)."""
    if not isinstance(raw, dict):
        return None
    if not isinstance(raw.get("id"), str):
        return None
    if not isinstance(raw.get("type"), str):
        return None
    if not isinstance(raw.get("enabled"), bool):
        return None
    return {
        "id": raw["id"],
        "type": raw["type"],
        "enabled": raw["enabled"],
        "customer_id": raw.get("customer_id") if isinstance(raw.get("customer_id"), str) else None,
        "config": raw["config"] if isinstance(raw.get("config"), dict) else {},
    }


def find_applicable_budget_rules(
    rules: list[Any], customer_id: str | None
) -> list[dict[str, Any]]:
    """Every active ``budget_limit`` rule that applies to the customer, in
    cache order. The server (computeBudgetExceededFlags) evaluates ALL
    applicable budget rules per customer, so the SDK must match: a
    customer-specific cap is a constraint IN ADDITION to any global rule,
    never shadowed by it. Matching: rule.customer_id is None → applies to all
    end-users (scope flag disambiguates); == customer_id → that customer only.
    """
    matches: list[dict[str, Any]] = []
    for raw in rules:
        rule = narrow_rule(raw)
        if rule is None:
            continue
        if not rule["enabled"]:
            continue
        if rule["type"] != RULE_TYPE_BUDGET_LIMIT:
            continue
        cfg = rule["config"]
        limit_usd = cfg.get("limit_usd")
        period = cfg.get("period")
        hard_stop = cfg.get("hard_stop")
        scope = cfg.get("scope")
        if not isinstance(limit_usd, (int, float)) or limit_usd <= 0:
            continue
        if period not in ("hour", "day", "week", "month"):
            continue
        if scope not in ("per_customer", "pooled"):
            continue
        if not isinstance(hard_stop, bool):
            continue
        if rule["customer_id"] is not None and rule["customer_id"] != customer_id:
            continue
        matches.append(
            {
                "rule_id": rule["id"],
                "scope": scope,
                "scope_token_customer_id": None if scope == "pooled" else customer_id,
                "period": period,
                "limit_usd": float(limit_usd),
                "hard_stop": hard_stop,
            }
        )
    return matches


def period_start_utc(period: str, at: datetime | None = None) -> str:
    raw = at or datetime.now(tz=timezone.utc)
    if raw.tzinfo is None:
        raw = raw.replace(tzinfo=timezone.utc)
    d = raw.astimezone(timezone.utc).replace(microsecond=0, second=0, minute=0)
    if period == "hour":
        return _canonical_period_start(d.isoformat())
    d = d.replace(hour=0)
    if period == "day":
        return _canonical_period_start(d.isoformat())
    if period == "week":
        # ISO Monday start. `weekday()` is Mon=0..Sun=6, so subtract that many
        # days. Use timedelta (not `replace(day=...)`) so the week's Monday
        # correctly rolls into the previous month/year — `replace` clamps to
        # the 1st, fragmenting the weekly budget accumulator key across the
        # month boundary and under-enforcing hard-stop budgets. Matches the
        # TS SDK's `setUTCDate(getUTCDate() - back)` (parity).
        d = d - timedelta(days=d.weekday())
        return _canonical_period_start(d.isoformat())
    # month
    d = d.replace(day=1)
    return _canonical_period_start(d.isoformat())


def record_llm_spend(
    *,
    customer_id: str | None,
    provider: str | None,
    model: str | None,
    tokens_in: float | None,
    tokens_out: float | None,
) -> None:
    """Record the actual cost of a completed LLM call against every applicable
    budget rule's accumulator key, priced from the local pricing cache. Keeps
    hard stops near-real-time in-process instead of waiting for the backend
    ingest flag / 5-min sync. Fail-open: unknown pricing, degraded rules
    cache, or zero-token events are a no-op — the backend flag stays
    authoritative and the sync loop replaces local totals with server truth
    (I-T3-3).
    """
    ensure_pricing_cache_background()
    if is_passthrough():
        return
    if not provider or not model:
        return
    t_in = float(tokens_in) if isinstance(tokens_in, (int, float)) and tokens_in > 0 else 0.0
    t_out = float(tokens_out) if isinstance(tokens_out, (int, float)) and tokens_out > 0 else 0.0
    if t_in == 0.0 and t_out == 0.0:
        return
    pricing = get_pricing(provider, model)
    if pricing is None:
        return
    cost = (t_in * pricing["input_per_1m"] + t_out * pricing["output_per_1m"]) / 1_000_000
    if not cost > 0:
        return
    for match in find_applicable_budget_rules(get_cached_rules(), customer_id):
        add(
            AccumulatorKey(
                rule_id=match["rule_id"],
                scope=match["scope"],
                customer_id=match["scope_token_customer_id"],
                period_start=period_start_utc(match["period"]),
            ),
            cost,
        )
