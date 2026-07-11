"""SDK pre-call rules engine.

Pure module: takes cached rules + per-call context, returns a single
``RuleDecision`` the wrapper applies. The engine never does I/O — all
ClickHouse / network calls are the wrapper's job, so the hot path stays
synchronous and cheap.

Conflict resolution (D27): most-specific-wins. Specificity is scored by
:func:`_score_model_routing`; same score → most recently updated rule takes
precedence.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal

from .failover import ReliabilityFailoverConfig
from .model_routing import ModelRoutingFallback, RuleWarningCode

_log = logging.getLogger("pylva")

RuleDecisionAction = Literal["allow", "block", "route_model", "failover"]

# Rule type strings — Python doesn't have a shared workspace package, so the
# enum values from `@pylva/shared` are duplicated here. Keep in sync
# with packages/shared/src/types/rules.ts.
RULE_TYPE_BUDGET_LIMIT = "budget_limit"
RULE_TYPE_MODEL_ROUTING = "model_routing"
RULE_TYPE_RELIABILITY_FAILOVER = "reliability_failover"

# Specificity tiers — higher = more specific. Numeric encoding makes
# `a.score > b.score` the entire tiebreak.
SPECIFICITY_CUSTOMER_STEP_MODEL = 6
SPECIFICITY_CUSTOMER_STEP = 5
SPECIFICITY_CUSTOMER = 4
SPECIFICITY_GLOBAL_STEP_MODEL = 3
SPECIFICITY_GLOBAL_STEP = 2
SPECIFICITY_GLOBAL = 1


@dataclass(frozen=True)
class RuleWarning:
    code: RuleWarningCode
    message: str


@dataclass
class CachedRule:
    """Minimal cached-rule shape — narrowed at the engine boundary."""

    id: str
    type: str
    enabled: bool
    status: Literal["active", "draft"]
    customer_id: str | None
    config: dict[str, Any]
    updated_at: Any  # str (ISO) or datetime


@dataclass
class PreCallContext:
    customer_id: str | None
    step_name: str | None
    provider: str | None
    model: str | None


# Decision shape mirrors the TS discriminated union. Python uses a single
# class; consumers branch on `action`.
@dataclass
class RuleDecision:
    action: RuleDecisionAction
    rule_id: str | None = None
    reason: Literal["budget_exceeded"] | None = None
    provider: str | None = None
    model: str | None = None
    original_model: str | None = None
    fallback: ModelRoutingFallback | None = None
    warnings: list[RuleWarning] = field(default_factory=list)


@dataclass
class FailoverRuleMatch:
    rule_id: str
    cfg: ReliabilityFailoverConfig


@dataclass
class EngineEvaluation:
    decision: RuleDecision
    routing: _RoutingCandidate | None = None
    failover: FailoverRuleMatch | None = None


def _is_cached(raw: Any) -> bool:
    if not isinstance(raw, dict):
        return False
    if not isinstance(raw.get("id"), str):
        return False
    if not isinstance(raw.get("type"), str):
        return False
    if not isinstance(raw.get("enabled"), bool):
        return False
    if raw.get("status") not in ("active", "draft"):
        return False
    if not isinstance(raw.get("config"), dict):
        return False
    return True


def narrow_rules(raw_rules: list[Any]) -> list[CachedRule]:
    """Coarse-narrow the cache. Returns active+enabled rules only."""
    out: list[CachedRule] = []
    for r in raw_rules:
        if not _is_cached(r):
            continue
        if not r["enabled"]:
            continue
        if r["status"] != "active":
            continue
        out.append(
            CachedRule(
                id=r["id"],
                type=r["type"],
                enabled=r["enabled"],
                status=r["status"],
                customer_id=r.get("customer_id"),
                config=r["config"],
                updated_at=r.get("updated_at"),
            )
        )
    return out


def _score_model_routing(
    cfg: dict[str, Any], ctx: PreCallContext, rule_customer_id: str | None
) -> int | None:
    """Score how specific a model_routing rule is for the given context.
    Higher = more specific. Returns None when match selectors don't match."""
    # `or {}` only covers a missing/None match — a non-dict value (e.g. the
    # backend reshapes match into a list of selectors) would still raise
    # AttributeError out of the wrapper (R1, bug_013 class). Same guard as
    # the TS engine's scoreModelRouting.
    raw_match = cfg.get("match")
    match = raw_match if isinstance(raw_match, dict) else {}
    cfg_customer = rule_customer_id if rule_customer_id is not None else match.get("customer_id")

    if cfg_customer is not None and cfg_customer != ctx.customer_id:
        return None

    if match.get("step_name") and match.get("step_name") != ctx.step_name:
        return None
    if match.get("provider") and match.get("provider") != ctx.provider:
        return None
    if match.get("model") and match.get("model") != ctx.model:
        return None

    has_customer = cfg_customer is not None
    has_step = bool(match.get("step_name"))
    has_model = bool(match.get("model"))

    if has_customer and has_step and has_model:
        return SPECIFICITY_CUSTOMER_STEP_MODEL
    if has_customer and has_step:
        return SPECIFICITY_CUSTOMER_STEP
    if has_customer:
        return SPECIFICITY_CUSTOMER
    if has_step and has_model:
        return SPECIFICITY_GLOBAL_STEP_MODEL
    if has_step:
        return SPECIFICITY_GLOBAL_STEP
    return SPECIFICITY_GLOBAL


@dataclass
class _RoutingCandidate:
    rule: CachedRule
    cfg: dict[str, Any]
    score: int


def _to_ts(updated_at: Any) -> float:
    """Parse the cache's `updated_at` field — ISO string or datetime."""
    if isinstance(updated_at, datetime):
        return updated_at.timestamp()
    if isinstance(updated_at, str):
        try:
            # Python's fromisoformat accepts the trailing 'Z' since 3.11; for
            # older runtimes we'd need dateutil. fromisoformat raises on a
            # bare 'Z' in 3.9/3.10, so we strip it.
            return datetime.fromisoformat(updated_at.replace("Z", "+00:00")).timestamp()
        except ValueError:
            return 0.0
    return 0.0


def _pick_routing_rule(rules: list[CachedRule], ctx: PreCallContext) -> _RoutingCandidate | None:
    # Build (candidate, sort_key) pairs once so the sort doesn't re-parse
    # `updated_at` on every comparison.
    keyed: list[tuple[_RoutingCandidate, tuple[int, float]]] = []
    for rule in rules:
        if rule.type != RULE_TYPE_MODEL_ROUTING:
            continue
        score = _score_model_routing(rule.config, ctx, rule.customer_id)
        if score is None:
            continue
        candidate = _RoutingCandidate(rule=rule, cfg=rule.config, score=score)
        keyed.append((candidate, (-score, -_to_ts(rule.updated_at))))
    if not keyed:
        return None
    keyed.sort(key=lambda pair: pair[1])
    return keyed[0][0]


def _find_failover_rule(rules: list[CachedRule], ctx: PreCallContext) -> FailoverRuleMatch | None:
    for rule in rules:
        if rule.type != RULE_TYPE_RELIABILITY_FAILOVER:
            continue
        cfg = rule.config
        if not cfg.get("enabled"):
            continue
        if cfg.get("customer_id") != ctx.customer_id:
            continue
        if cfg.get("primary_provider") != ctx.provider:
            continue
        # Defensive construction (bug_013): the constructor below uses
        # hard subscripts on six fields AND `float()` coercion on five of
        # them, so a malformed cached rule (e.g. backend schema bumped
        # without bumping the SDK) raises an exception that escapes through
        # `_setup_engine` (no try/except) straight to the host wrapper — an
        # R1 isolation violation. A missing field raises KeyError; a
        # present-but-non-numeric value raises ValueError (e.g.
        # `float("high")`, `float("")`) or TypeError (e.g. `float(None)`
        # from a JSON `null`). The cache is unvalidated JSON (same class as
        # the route_to coercion above), so all three must be caught. Skip
        # the rule with a one-time warning. The diagnostic carries the
        # error class name only (R1 — message can leak secrets).
        try:
            failover_cfg = ReliabilityFailoverConfig(
                enabled=cfg["enabled"],
                customer_id=cfg["customer_id"],
                primary_provider=cfg["primary_provider"],
                backup_provider=cfg["backup_provider"],
                trigger_error_rate_pct=float(cfg["trigger_error_rate_pct"]),
                recover_error_rate_pct=float(cfg["recover_error_rate_pct"]),
                window_seconds=float(cfg["window_seconds"]),
                recover_after_seconds=float(cfg["recover_after_seconds"]),
                recovery_probe_after_seconds=float(cfg["recovery_probe_after_seconds"]),
                consent_to_cost_shift=bool(cfg.get("consent_to_cost_shift", False)),
            )
        except (KeyError, ValueError, TypeError) as err:
            _log.warning(
                "skipping malformed reliability_failover rule",
                extra={"rule_id": rule.id, "error_class": type(err).__name__},
            )
            continue
        return FailoverRuleMatch(rule_id=rule.id, cfg=failover_cfg)
    return None


def _build_fallback(raw: Any) -> ModelRoutingFallback | None:
    if not isinstance(raw, dict):
        return None
    return ModelRoutingFallback(
        on_cross_provider_auth_error=bool(raw.get("on_cross_provider_auth_error", False)),
        on_access_denied=bool(raw.get("on_access_denied", False)),
        on_model_not_found=bool(raw.get("on_model_not_found", False)),
        use_original_model=bool(raw.get("use_original_model", False)),
        skip_same_provider_401=bool(raw.get("skip_same_provider_401", False)),
    )


def evaluate_pre_call(raw_rules: list[Any], ctx: PreCallContext) -> EngineEvaluation:
    rules = narrow_rules(raw_rules)

    # 1. Failover rule lookup.
    failover = _find_failover_rule(rules, ctx)

    # 2. Model routing — most-specific-wins.
    routing = _pick_routing_rule(rules, ctx)
    if routing is not None:
        cfg = routing.cfg
        raw_route_to = cfg.get("route_to")
        route_to = raw_route_to if isinstance(raw_route_to, dict) else {}
        # The cache is unvalidated JSON (bug_013 class): route_to.provider /
        # route_to.model may be a non-string after a backend schema bump or a
        # malformed rule row. Coerce anything non-string to None so the
        # `decision.model` guard in _engine.py degrades to the original model.
        # Without this, a truthy non-string model (e.g. a JSON number) passes
        # that truthiness-only guard and is forwarded straight into the
        # provider call — which 400s and raises to the host agent (R1
        # violation). Mirrors the TS engine's routingApplication string check
        # (rules_engine.ts:146); the `decision.model and decision.fallback`
        # guard alone is NOT equivalent for truthy non-string values.
        raw_provider = route_to.get("provider")
        raw_model = route_to.get("model")
        provider = raw_provider if isinstance(raw_provider, str) else None
        model = raw_model if isinstance(raw_model, str) else None
        fallback = _build_fallback(cfg.get("fallback"))
        return EngineEvaluation(
            decision=RuleDecision(
                action="route_model",
                rule_id=routing.rule.id,
                provider=provider,
                model=model,
                original_model=ctx.model or "",
                fallback=fallback,
            ),
            routing=routing,
            failover=failover,
        )

    return EngineEvaluation(
        decision=RuleDecision(action="allow"),
        failover=failover,
    )


def _reset_engine_for_tests() -> None:
    # No mutable engine state today. Keep the hook for test parity.
    return None
