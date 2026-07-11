"""B3-T1 — Anthropic wrapper coverage.

Mirror of test_openai_wrapper.py for the Anthropic surface. Uses an injected
fake `anthropic.resources.messages` module so the wrapper can be exercised
without the real SDK installed.
"""

from __future__ import annotations

import sys
import types
from typing import Any

import pytest

import pylva
from pylva.core import telemetry
from pylva.wrappers import anthropic_wrapper

VALID_KEY = "pv_live_12345678_" + "a" * 32


def setup_function(_fn: object) -> None:
    # Engine + cache + failover state are reset by tests/conftest.py.
    telemetry._reset_telemetry_for_tests()  # type: ignore[attr-defined]
    anthropic_wrapper._reset_anthropic_patch_for_tests()  # type: ignore[attr-defined]
    for name in list(sys.modules):
        if name == "anthropic" or name.startswith("anthropic."):
            del sys.modules[name]


def test_try_patch_does_not_raise_without_anthropic() -> None:
    anthropic_wrapper.try_patch_anthropic()


def test_try_patch_is_idempotent() -> None:
    anthropic_wrapper.try_patch_anthropic()
    anthropic_wrapper.try_patch_anthropic()


class _FakeUsage:
    def __init__(self, input_tokens: int, output_tokens: int) -> None:
        self.input_tokens = input_tokens
        self.output_tokens = output_tokens


class _FakeMessage:
    def __init__(self, model: str, input_tokens: int, output_tokens: int) -> None:
        self.model = model
        self.usage = _FakeUsage(input_tokens, output_tokens)
        self.content = [{"type": "text", "text": "secret response"}]


def _install_fake_anthropic(raise_exc: Exception | None = None) -> Any:
    anthropic_pkg = types.ModuleType("anthropic")
    resources_pkg = types.ModuleType("anthropic.resources")
    messages_mod = types.ModuleType("anthropic.resources.messages")

    class Messages:
        def create(self, **kwargs: Any) -> Any:
            if raise_exc is not None:
                raise raise_exc
            return _FakeMessage(kwargs.get("model", "claude-3-5-sonnet-20241022"), 12, 7)

    messages_mod.Messages = Messages  # type: ignore[attr-defined]
    sys.modules["anthropic"] = anthropic_pkg
    sys.modules["anthropic.resources"] = resources_pkg
    sys.modules["anthropic.resources.messages"] = messages_mod
    return Messages


def test_wrapper_extracts_token_counts() -> None:
    pylva.init(VALID_KEY, local_mode=True)
    Messages = _install_fake_anthropic()
    anthropic_wrapper.try_patch_anthropic()
    model = "claude/custom model+v1@prod_モデル"

    resp = Messages().create(model=model, messages=[{"role": "user", "content": "hi"}])
    assert resp.model == model
    assert telemetry.buffer_size() == 1

    event = telemetry._state.buffer[0]  # type: ignore[attr-defined]
    assert event["provider"] == "anthropic"
    assert event["model"] == model
    assert event["tokens_in"] == 12
    assert event["tokens_out"] == 7
    assert event["status"] == "success"


def test_wrapper_does_not_capture_prompt_or_response() -> None:
    pylva.init(VALID_KEY, local_mode=True)
    Messages = _install_fake_anthropic()
    anthropic_wrapper.try_patch_anthropic()

    prompt = "ANTHROPIC SECRET PROMPT"
    Messages().create(model="claude-3-5-sonnet-20241022", messages=[{"role": "user", "content": prompt}])

    event = telemetry._state.buffer[0]  # type: ignore[attr-defined]
    for forbidden_key in ("prompt", "response", "messages", "completion", "content"):
        assert forbidden_key not in event
    assert not any(isinstance(v, str) and prompt in v for v in event.values())


def test_wrapper_swallows_telemetry_failures_r1() -> None:
    pylva.init(VALID_KEY, local_mode=True)
    Messages = _install_fake_anthropic()
    anthropic_wrapper.try_patch_anthropic()

    def boom(_ev: Any) -> None:
        raise RuntimeError("enqueue is on fire")

    original_enqueue = anthropic_wrapper.enqueue
    anthropic_wrapper.enqueue = boom  # type: ignore[assignment]
    try:
        resp = Messages().create(model="claude-3-5-sonnet-20241022", messages=[])
        assert resp.model == "claude-3-5-sonnet-20241022"
    finally:
        anthropic_wrapper.enqueue = original_enqueue  # type: ignore[assignment]


def test_wrapper_emits_failure_event_when_sdk_raises() -> None:
    pylva.init(VALID_KEY, local_mode=True)
    Messages = _install_fake_anthropic(raise_exc=RuntimeError("anthropic 500"))
    anthropic_wrapper.try_patch_anthropic()

    with pytest.raises(RuntimeError):
        Messages().create(model="claude-3-5-sonnet-20241022", messages=[])

    event = telemetry._state.buffer[0]  # type: ignore[attr-defined]
    assert event["status"] == "failure"
    assert event["tokens_in"] == 0
    assert event["tokens_out"] == 0


def test_wrapper_attaches_pylva_metadata_to_response() -> None:
    pylva.init(VALID_KEY, local_mode=True)
    Messages = _install_fake_anthropic()  # noqa: N806 — class object
    anthropic_wrapper.try_patch_anthropic()

    resp = Messages().create(model="claude-3-5-sonnet-20241022", messages=[])
    assert hasattr(resp, "_pylva")
    assert resp._pylva.original_model == "claude-3-5-sonnet-20241022"
    assert resp._pylva.routing_applied is False


def test_wrapper_skips_failure_telemetry_on_intentional_refusal() -> None:
    """PylvaBudgetExceeded is a refusal, not a provider failure."""
    from pylva.core import budget_accumulator as ba
    from pylva.core import rules_cache
    from pylva.errors.budget_exceeded import PylvaBudgetExceeded
    from pylva.wrappers._budget import _period_start_utc

    pylva.init(VALID_KEY, local_mode=True)
    Messages = _install_fake_anthropic()  # noqa: N806 — class object
    anthropic_wrapper.try_patch_anthropic()

    rules_cache._rules.append(  # type: ignore[attr-defined]
        {
            "id": "r1",
            "type": "budget_limit",
            "enabled": True,
            "customer_id": "cust_42",
            "config": {
                "limit_usd": 10,
                "period": "day",
                "hard_stop": True,
                "scope": "per_customer",
            },
        }
    )
    ba.mark_exceeded_from_backend(
        rule_id="r1",
        customer_id="cust_42",
        limit_usd=10,
        period_start=_period_start_utc("day"),
    )

    with pytest.raises(PylvaBudgetExceeded):
        with pylva.track_context("cust_42"):
            Messages().create(model="claude-3-5-sonnet-20241022", messages=[])

    assert telemetry.buffer_size() == 0
