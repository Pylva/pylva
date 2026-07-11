"""B4-T1 rules engine — Python parity tests for
``packages/sdk-ts/tests/rules_engine.test.ts``."""

from __future__ import annotations

from typing import Any

from pylva.core.rules_engine import (
    PreCallContext,
    _reset_engine_for_tests,
    evaluate_pre_call,
    narrow_rules,
)

FALLBACK = {
    "on_cross_provider_auth_error": True,
    "on_access_denied": True,
    "on_model_not_found": True,
    "use_original_model": True,
    "skip_same_provider_401": True,
}


def _ctx(
    *,
    customer_id: str = "cust_1",
    step_name: str | None = "summarize",
    provider: str | None = "openai",
    model: str | None = "gpt-4o",
) -> PreCallContext:
    return PreCallContext(
        customer_id=customer_id, step_name=step_name, provider=provider, model=model
    )


def _routing_rule(
    *,
    rule_id: str = "r1",
    rule_customer_id: str | None = None,
    match: dict[str, Any] | None = None,
    route_to_provider: str = "openai",
    route_to_model: str = "gpt-4o-mini",
    updated_at: str = "2026-04-26T00:00:00Z",
) -> dict[str, Any]:
    return {
        "id": rule_id,
        "type": "model_routing",
        "enabled": True,
        "status": "active",
        "customer_id": rule_customer_id,
        "updated_at": updated_at,
        "config": {
            "scope": "per_customer",
            "match": match or {},
            "route_to": {"provider": route_to_provider, "model": route_to_model},
            "fallback": FALLBACK,
        },
    }


def _failover_rule(
    *,
    rule_id: str = "f1",
    customer_id: str = "cust_1",
    primary: str = "openai",
    backup: str = "anthropic",
    enabled: bool = True,
) -> dict[str, Any]:
    return {
        "id": rule_id,
        "type": "reliability_failover",
        "enabled": True,
        "status": "active",
        "customer_id": customer_id,
        "updated_at": "2026-04-26T00:00:00Z",
        "config": {
            "enabled": enabled,
            "customer_id": customer_id,
            "primary_provider": primary,
            "backup_provider": backup,
            "trigger_error_rate_pct": 10,
            "recover_error_rate_pct": 2,
            "window_seconds": 60,
            "recover_after_seconds": 60,
            "recovery_probe_after_seconds": 1800,
            "consent_to_cost_shift": True,
        },
    }


def setup_function(_fn: object) -> None:
    _reset_engine_for_tests()


# ---------- narrow_rules -----------------------------------------------------


def test_narrow_rules_filters_disabled_and_draft() -> None:
    raw = [
        {"id": "r1", "type": "model_routing", "enabled": False, "status": "active", "config": {}},
        {"id": "r2", "type": "model_routing", "enabled": True, "status": "draft", "config": {}},
        {"id": "r3", "type": "model_routing", "enabled": True, "status": "active", "config": {}},
        "not-a-rule",
        {"id": "r4", "type": 123, "enabled": True, "status": "active", "config": {}},  # bad type
    ]
    out = narrow_rules(raw)
    assert [r.id for r in out] == ["r3"]


# ---------- evaluate_pre_call: pass-through ---------------------------------


def test_no_rules_returns_allow() -> None:
    out = evaluate_pre_call([], _ctx())
    assert out.decision.action == "allow"
    assert out.failover is None


# ---------- model routing: most-specific wins -------------------------------


def test_model_routing_global_match() -> None:
    rule = _routing_rule(match={"provider": "openai"}, route_to_model="gpt-4o-mini")
    out = evaluate_pre_call([rule], _ctx())
    assert out.decision.action == "route_model"
    assert out.decision.model == "gpt-4o-mini"
    assert out.decision.original_model == "gpt-4o"


def test_model_routing_preserves_arbitrary_provider_and_model() -> None:
    original_model = "ft:gpt-4o-mini:org/name+v1@prod"
    routed_model = "ollama/llama3.1-8b"
    rule = _routing_rule(
        match={"provider": "openai.chat", "model": original_model},
        route_to_provider="ollama",
        route_to_model=routed_model,
    )

    out = evaluate_pre_call(
        [rule],
        _ctx(provider="openai.chat", model=original_model),
    )

    assert out.decision.action == "route_model"
    assert out.decision.provider == "ollama"
    assert out.decision.model == routed_model
    assert out.decision.original_model == original_model


def test_no_match_when_provider_differs() -> None:
    rule = _routing_rule(match={"provider": "anthropic"})
    out = evaluate_pre_call([rule], _ctx(provider="openai"))
    assert out.decision.action == "allow"


def test_more_specific_rule_wins() -> None:
    """customer+step+model > customer+step > customer > global+step+model > global+step > global"""
    less = _routing_rule(rule_id="less", match={"step_name": "summarize"})
    more = _routing_rule(
        rule_id="more",
        rule_customer_id="cust_1",
        match={"step_name": "summarize", "model": "gpt-4o"},
        route_to_model="gpt-4o-mini-MORE",
    )
    out = evaluate_pre_call([less, more], _ctx())
    assert out.decision.rule_id == "more"
    assert out.decision.model == "gpt-4o-mini-MORE"


def test_empty_rule_customer_id_does_not_fall_through_to_match_customer_id() -> None:
    rule = _routing_rule(
        rule_customer_id="",
        match={"customer_id": "cust_1", "step_name": "summarize"},
    )
    out = evaluate_pre_call([rule], _ctx(customer_id="cust_1"))
    assert out.decision.action == "allow"


def test_same_specificity_ties_break_by_updated_at() -> None:
    older = _routing_rule(
        rule_id="older",
        match={"step_name": "summarize"},
        route_to_model="gpt-4o-mini-OLD",
        updated_at="2025-01-01T00:00:00Z",
    )
    newer = _routing_rule(
        rule_id="newer",
        match={"step_name": "summarize"},
        route_to_model="gpt-4o-mini-NEW",
        updated_at="2026-04-26T00:00:00Z",
    )
    out = evaluate_pre_call([older, newer], _ctx())
    assert out.decision.rule_id == "newer"
    assert out.decision.model == "gpt-4o-mini-NEW"


def test_rule_customer_id_filters_other_customers() -> None:
    rule = _routing_rule(
        rule_customer_id="cust_2",
        match={"step_name": "summarize"},
    )
    out = evaluate_pre_call([rule], _ctx(customer_id="cust_1"))
    assert out.decision.action == "allow"


# ---------- failover surfacing ----------------------------------------------


def test_failover_rule_surfaced_alongside_allow() -> None:
    rule = _failover_rule(customer_id="cust_1", primary="openai", backup="anthropic")
    out = evaluate_pre_call([rule], _ctx(provider="openai", customer_id="cust_1"))
    assert out.decision.action == "allow"
    assert out.failover is not None
    assert out.failover.cfg.backup_provider == "anthropic"


def test_failover_rule_accepts_arbitrary_provider_ids() -> None:
    rule = _failover_rule(customer_id="cust_1", primary="openai.chat", backup="ollama/local")
    out = evaluate_pre_call([rule], _ctx(provider="openai.chat", customer_id="cust_1"))

    assert out.decision.action == "allow"
    assert out.failover is not None
    assert out.failover.cfg.primary_provider == "openai.chat"
    assert out.failover.cfg.backup_provider == "ollama/local"


def test_failover_rule_filtered_when_primary_provider_differs() -> None:
    rule = _failover_rule(primary="openai")
    out = evaluate_pre_call([rule], _ctx(provider="anthropic"))
    assert out.failover is None


def test_failover_rule_filtered_when_customer_differs() -> None:
    rule = _failover_rule(customer_id="cust_1")
    out = evaluate_pre_call([rule], _ctx(customer_id="cust_2", provider="openai"))
    assert out.failover is None


def test_failover_filtered_when_cfg_disabled() -> None:
    rule = _failover_rule(enabled=False)
    out = evaluate_pre_call([rule], _ctx(provider="openai"))
    assert out.failover is None


def test_routing_and_failover_compose() -> None:
    """When both a routing rule AND a failover rule match, the engine
    surfaces both — wrapper handles them independently."""
    routing = _routing_rule(match={"step_name": "summarize"})
    failover = _failover_rule(primary="openai", backup="anthropic")
    out = evaluate_pre_call([routing, failover], _ctx())
    assert out.decision.action == "route_model"
    assert out.failover is not None


# ---------- bug_013 regression: malformed failover cfg ----------------------


def test_partial_failover_cfg_is_skipped_not_raised() -> None:
    """A reliability_failover rule whose cached config is missing a
    required field (here `recovery_probe_after_seconds` — the most
    recently added one) must NOT raise out of `evaluate_pre_call`.
    Previously KeyError escaped through `_setup_engine` (no try/except)
    into the host wrapper — an R1 isolation violation.
    """
    rule = _failover_rule()
    # Drop the field that bug_013 calls out as the regression vector.
    del rule["config"]["recovery_probe_after_seconds"]

    out = evaluate_pre_call([rule], _ctx())

    # Engine returns ALLOW (no failover surfaced) instead of crashing.
    assert out.decision.action == "allow"
    assert out.failover is None


def test_partial_failover_cfg_does_not_block_other_rules() -> None:
    """A malformed failover rule must be skipped silently so other
    rules in the cache (here a model_routing rule) still apply.
    """
    bad = _failover_rule(rule_id="f-bad")
    del bad["config"]["backup_provider"]
    routing = _routing_rule(match={"step_name": "summarize"})

    out = evaluate_pre_call([bad, routing], _ctx())

    assert out.decision.action == "route_model"
    assert out.failover is None  # bad rule didn't surface


def test_non_dict_match_does_not_raise() -> None:
    """`or {}` only covered a missing/None match — a truthy non-dict value
    (e.g. the backend reshapes `match` into a list of selectors) raised
    AttributeError out of `evaluate_pre_call` into the host wrapper (R1,
    bug_013 class). Must be treated as match-any instead."""
    rule = _routing_rule()
    rule["config"]["match"] = [{"step_name": "summarize"}]

    out = evaluate_pre_call([rule], _ctx())

    assert out.decision.action == "route_model"
    assert out.decision.model == "gpt-4o-mini"


def test_non_dict_route_to_degrades_to_unrouted_call() -> None:
    """Same guard for `route_to`: a truthy non-dict value raised
    AttributeError mid-call. The decision must surface with model=None so
    `run_with_engine` skips routing and the call proceeds unrouted."""
    rule = _routing_rule(match={"step_name": "summarize"})
    rule["config"]["route_to"] = ["openai", "gpt-4o-mini"]

    out = evaluate_pre_call([rule], _ctx())

    assert out.decision.action == "route_model"
    assert out.decision.provider is None
    assert out.decision.model is None


def test_non_string_route_to_model_coerced_to_none() -> None:
    """Parity with TS `degrades to allow when route_to.model is not a string`
    (rules_engine.test.ts:261). A truthy non-string model (e.g. a JSON number
    from a malformed/forward-rev cached rule) must NOT survive into the
    decision — otherwise `_engine.py`'s `decision.model and decision.fallback`
    truthiness guard forwards it into the provider call, which 400s and raises
    to the host (R1 violation). The engine coerces it to None so the call
    degrades to the original model."""
    rule = _routing_rule(match={"step_name": "summarize"})
    rule["config"]["route_to"] = {"provider": "openai", "model": 123}

    out = evaluate_pre_call([rule], _ctx())

    assert out.decision.action == "route_model"
    assert out.decision.model is None


def test_non_string_route_to_provider_coerced_to_none() -> None:
    """Same string guard for `route_to.provider` — a non-string provider must
    not reach the same-provider comparison in `_engine.py`."""
    rule = _routing_rule(match={"step_name": "summarize"})
    rule["config"]["route_to"] = {"provider": 7, "model": "gpt-4o-mini"}

    out = evaluate_pre_call([rule], _ctx())

    assert out.decision.action == "route_model"
    assert out.decision.provider is None
    assert out.decision.model == "gpt-4o-mini"


# ---------- bug_013 class: non-numeric failover cfg fields -------------------
# The bug_013 regression above only covered a MISSING field (KeyError). The
# failover constructor also `float()`-coerces five fields, so a present-but-
# non-numeric value raised ValueError/TypeError — NOT caught by the old
# `except KeyError` — and escaped through `_setup_engine` (called outside
# `run_with_engine`'s try) into the host wrapper, which re-raises any
# non-refusal error to the host agent (R1 violation). Sibling of the #297
# route_to coercion fix: the cache is unvalidated JSON.


def test_non_numeric_string_failover_field_is_skipped_not_raised() -> None:
    """A `float()`-coerced field arriving as a non-numeric JSON string must
    be skipped, not raise ValueError out of `evaluate_pre_call`."""
    rule = _failover_rule()
    rule["config"]["trigger_error_rate_pct"] = "high"  # float("high") -> ValueError

    out = evaluate_pre_call([rule], _ctx())

    assert out.decision.action == "allow"
    assert out.failover is None


def test_empty_string_failover_field_is_skipped_not_raised() -> None:
    """An empty-string numeric field (`float("")` -> ValueError) must be
    skipped rather than crash the host call."""
    rule = _failover_rule()
    rule["config"]["window_seconds"] = ""

    out = evaluate_pre_call([rule], _ctx())

    assert out.decision.action == "allow"
    assert out.failover is None


def test_null_failover_field_is_skipped_not_raised() -> None:
    """A JSON `null` (Python `None`) numeric field (`float(None)` ->
    TypeError) must be skipped, not raise into the host wrapper."""
    rule = _failover_rule()
    rule["config"]["recovery_probe_after_seconds"] = None

    out = evaluate_pre_call([rule], _ctx())

    assert out.decision.action == "allow"
    assert out.failover is None


def test_malformed_numeric_failover_does_not_block_other_rules() -> None:
    """A failover rule with a non-numeric field must be skipped silently so
    other rules in the cache (here a model_routing rule) still apply."""
    bad = _failover_rule(rule_id="f-bad")
    bad["config"]["recover_after_seconds"] = "soon"
    routing = _routing_rule(match={"step_name": "summarize"})

    out = evaluate_pre_call([bad, routing], _ctx())

    assert out.decision.action == "route_model"
    assert out.failover is None  # bad rule didn't surface
