"""Enforce-ALL budget semantics (contract-pinned, shared with the TS SDK via
tests/contracts/budget-rule-selection-contract.json) plus local spend
recording via record_llm_spend."""

from __future__ import annotations

import json
import os
from typing import Any

import pytest

from pylva.core import budget_accumulator as ba
from pylva.core import pricing_cache, rules_cache
from pylva.core.budget_rules import period_start_utc, record_llm_spend
from pylva.errors.budget_exceeded import PylvaBudgetExceeded
from pylva.wrappers._budget import maybe_enforce_pre_call

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
CONTRACT_PATH = os.path.join(REPO_ROOT, "tests", "contracts", "budget-rule-selection-contract.json")

with open(CONTRACT_PATH, encoding="utf-8") as fp:
    CONTRACT: dict[str, Any] = json.load(fp)


def setup_function(_fn: object) -> None:
    rules_cache._reset_rules_cache_for_tests()  # type: ignore[attr-defined]
    ba._reset_accumulator_for_tests()  # type: ignore[attr-defined]
    pricing_cache._reset_pricing_cache_for_tests()  # type: ignore[attr-defined]


def _load_rules(rules: list[dict[str, Any]]) -> None:
    for i, rule in enumerate(rules):
        rules_cache._rules.append({"id": f"rule-{i}", **rule})  # type: ignore[attr-defined]


@pytest.mark.parametrize("case", CONTRACT["cases"], ids=[c["name"] for c in CONTRACT["cases"]])
def test_budget_rule_selection_contract(case: dict[str, Any]) -> None:
    _load_rules(case["rules"])
    for acc in case["accumulated"]:
        scope = "pooled" if acc["scope_customer_id"] is None else "per_customer"
        ba.add(
            ba.AccumulatorKey(
                rule_id=f"rule-{acc['rule_index']}",
                scope=scope,
                customer_id=acc["scope_customer_id"],
                period_start=period_start_utc(acc["period"]),
            ),
            acc["amount_usd"],
        )

    expected = case["expect"]
    if not expected["blocked"]:
        maybe_enforce_pre_call(customer_id=case["customer_id"], estimated_usd=0)
        return

    with pytest.raises(PylvaBudgetExceeded) as info:
        maybe_enforce_pre_call(customer_id=case["customer_id"], estimated_usd=0)
    assert info.value.rule_id == f"rule-{expected['blocked_by']}"
    if "blocked_customer_id" in expected:
        assert info.value.customer_id == expected["blocked_customer_id"]


def _day_rule(rule_id: str = "rule-local", **overrides: Any) -> dict[str, Any]:
    rule = {
        "id": rule_id,
        "type": "budget_limit",
        "enabled": True,
        "customer_id": None,
        "config": {"limit_usd": 1, "period": "day", "hard_stop": True, "scope": "per_customer"},
    }
    rule.update(overrides)
    return rule


def _seed_pricing() -> None:
    pricing_cache._set_pricing_for_tests(  # type: ignore[attr-defined]
        [
            {
                "provider": "openai",
                "model": "gpt-test",
                "input_per_1m": 1.0,
                "output_per_1m": 1.0,
            }
        ]
    )


def test_record_llm_spend_blocks_after_local_spend_crosses_limit() -> None:
    rules_cache._rules.append(_day_rule())  # type: ignore[attr-defined]
    _seed_pricing()

    # Two calls at $0.60 each: spend reaches $1.20 ≥ $1 → third call refused.
    maybe_enforce_pre_call(customer_id="alice", estimated_usd=0)
    record_llm_spend(
        customer_id="alice",
        provider="openai",
        model="gpt-test",
        tokens_in=300_000,
        tokens_out=300_000,
    )
    maybe_enforce_pre_call(customer_id="alice", estimated_usd=0)
    record_llm_spend(
        customer_id="alice",
        provider="openai",
        model="gpt-test",
        tokens_in=300_000,
        tokens_out=300_000,
    )

    with pytest.raises(PylvaBudgetExceeded):
        maybe_enforce_pre_call(customer_id="alice", estimated_usd=0)
    # Other customers are unaffected (per_customer scope).
    maybe_enforce_pre_call(customer_id="bob", estimated_usd=0)


def test_record_llm_spend_bumps_every_applicable_rule_key() -> None:
    rules_cache._rules.append(_day_rule("rule-global"))  # type: ignore[attr-defined]
    rules_cache._rules.append(_day_rule("rule-alice", customer_id="alice"))  # type: ignore[attr-defined]
    _seed_pricing()

    record_llm_spend(
        customer_id="alice",
        provider="openai",
        model="gpt-test",
        tokens_in=500_000,
        tokens_out=0,
    )

    period_start = period_start_utc("day")
    for rule_id in ("rule-global", "rule-alice"):
        entry = ba.get(
            ba.AccumulatorKey(
                rule_id=rule_id,
                scope="per_customer",
                customer_id="alice",
                period_start=period_start,
            )
        )
        assert entry.total_usd == pytest.approx(0.5)


def test_record_llm_spend_noops_on_unknown_pricing_and_zero_tokens() -> None:
    rules_cache._rules.append(_day_rule())  # type: ignore[attr-defined]

    # Pricing cache empty → no-op.
    record_llm_spend(
        customer_id="alice",
        provider="openai",
        model="gpt-test",
        tokens_in=500_000,
        tokens_out=0,
    )
    _seed_pricing()
    # Zero tokens / missing model → no-op.
    record_llm_spend(
        customer_id="alice", provider="openai", model="gpt-test", tokens_in=0, tokens_out=0
    )
    record_llm_spend(
        customer_id="alice", provider=None, model=None, tokens_in=500_000, tokens_out=0
    )

    maybe_enforce_pre_call(customer_id="alice", estimated_usd=0)


def test_per_customer_scope_with_null_identity_never_reads_pooled_bucket() -> None:
    rules_cache._rules.append(_day_rule("rule-pc"))  # type: ignore[attr-defined]
    # Seed what the old None→'__pooled__' collapse would have read.
    ba.add(
        ba.AccumulatorKey(
            rule_id="rule-pc",
            scope="pooled",
            customer_id=None,
            period_start=period_start_utc("day"),
        ),
        50.0,
    )
    # A per_customer check with null identity must not read the pooled token.
    maybe_enforce_pre_call(customer_id=None, estimated_usd=0)
