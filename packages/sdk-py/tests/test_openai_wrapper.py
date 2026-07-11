"""B3-T1 — OpenAI wrapper coverage.

The wrapper monkey-patches ``openai.resources.chat.completions.Completions``.
To test it without pulling in the real `openai` SDK (not a test dep), we inject
a minimal fake openai module into sys.modules. The wrapper then attaches to
the fake class exactly as it would to the real one.

Covers:
  * Patch is a silent no-op when the `openai` package is unavailable.
  * Patch is idempotent across repeated try_patch calls.
  * Token counts from `response.usage.prompt_tokens` / `completion_tokens`
    land on the enqueued event.
  * R3 privacy: the event payload never includes prompt text or response text.
  * R1 isolation: when `enqueue` raises, the patched caller still returns
    the model's response without propagating the telemetry error.
  * Failure path: SDK exceptions propagate, but a failure event is still enqueued.
"""

from __future__ import annotations

import sys
import types
from typing import Any

import pytest

import pylva
from pylva.core import telemetry
from pylva.wrappers import openai_wrapper

VALID_KEY = "pv_live_12345678_" + "a" * 32


def setup_function(_fn: object) -> None:
    # Engine + cache + failover state are reset by tests/conftest.py.
    # This setup only handles wrapper-test-specific state.
    telemetry._reset_telemetry_for_tests()  # type: ignore[attr-defined]
    openai_wrapper._reset_openai_patch_for_tests()  # type: ignore[attr-defined]
    for name in list(sys.modules):
        if name == "openai" or name.startswith("openai."):
            del sys.modules[name]


def test_try_patch_does_not_raise_without_openai() -> None:
    # No fake installed -> import inside try_patch fails -> silent no-op.
    openai_wrapper.try_patch_openai()


def test_try_patch_is_idempotent() -> None:
    openai_wrapper.try_patch_openai()
    openai_wrapper.try_patch_openai()


class _FakeUsage:
    def __init__(self, prompt: int, completion: int) -> None:
        self.prompt_tokens = prompt
        self.completion_tokens = completion


class _FakeResponse:
    def __init__(self, model: str, prompt: int, completion: int) -> None:
        self.model = model
        self.usage = _FakeUsage(prompt, completion)
        self.content = "this is a response body that must NOT be captured"


def _install_fake_openai(raise_exc: Exception | None = None) -> Any:
    """Build a minimal `openai.resources.chat.completions` module tree.

    Returns the Completions class so tests can call `Completions().create()`
    (which becomes the patched variant after try_patch_openai runs).
    """
    openai_pkg = types.ModuleType("openai")
    resources_pkg = types.ModuleType("openai.resources")
    chat_pkg = types.ModuleType("openai.resources.chat")
    completions_mod = types.ModuleType("openai.resources.chat.completions")

    class Completions:
        def create(self, **kwargs: Any) -> Any:
            if raise_exc is not None:
                raise raise_exc
            return _FakeResponse(kwargs.get("model", "gpt-4o-mini"), 10, 5)

    completions_mod.Completions = Completions  # type: ignore[attr-defined]
    sys.modules["openai"] = openai_pkg
    sys.modules["openai.resources"] = resources_pkg
    sys.modules["openai.resources.chat"] = chat_pkg
    sys.modules["openai.resources.chat.completions"] = completions_mod
    return Completions


def test_wrapper_extracts_token_counts() -> None:
    pylva.init(VALID_KEY, local_mode=True)
    Completions = _install_fake_openai()
    openai_wrapper.try_patch_openai()
    model = "ft:gpt-4o-mini:org/name+v1@prod モデル"

    resp = Completions().create(model=model, messages=[{"role": "user", "content": "hi"}])
    assert resp.model == model

    assert telemetry.buffer_size() == 1
    event = telemetry._state.buffer[0]  # type: ignore[attr-defined]
    assert event["provider"] == "openai"
    assert event["model"] == model
    assert event["tokens_in"] == 10
    assert event["tokens_out"] == 5
    assert event["status"] == "success"


def test_wrapper_does_not_capture_prompt_or_response() -> None:
    pylva.init(VALID_KEY, local_mode=True)
    Completions = _install_fake_openai()
    openai_wrapper.try_patch_openai()

    prompt = "SUPER SECRET PROMPT CONTENT"
    Completions().create(model="gpt-4o-mini", messages=[{"role": "user", "content": prompt}])

    event = telemetry._state.buffer[0]  # type: ignore[attr-defined]
    for forbidden_key in ("prompt", "response", "messages", "completion", "content"):
        assert forbidden_key not in event
    # Guard against the secret leaking into any stringified field.
    assert not any(isinstance(v, str) and prompt in v for v in event.values())


def test_wrapper_swallows_telemetry_failures_r1() -> None:
    pylva.init(VALID_KEY, local_mode=True)
    Completions = _install_fake_openai()
    openai_wrapper.try_patch_openai()

    # Swap enqueue for a bomb — R1 requires the patched call to still return
    # the SDK response without propagating the telemetry error.
    def boom(_ev: Any) -> None:
        raise RuntimeError("enqueue is on fire")

    original_enqueue = openai_wrapper.enqueue
    openai_wrapper.enqueue = boom  # type: ignore[assignment]
    try:
        resp = Completions().create(model="gpt-4o-mini", messages=[])
        assert resp.model == "gpt-4o-mini"
    finally:
        openai_wrapper.enqueue = original_enqueue  # type: ignore[assignment]


def test_wrapper_emits_failure_event_when_sdk_raises() -> None:
    pylva.init(VALID_KEY, local_mode=True)
    Completions = _install_fake_openai(raise_exc=RuntimeError("openai 500"))
    openai_wrapper.try_patch_openai()

    with pytest.raises(RuntimeError):
        Completions().create(model="gpt-4o-mini", messages=[])

    event = telemetry._state.buffer[0]  # type: ignore[attr-defined]
    assert event["status"] == "failure"
    assert event["tokens_in"] == 0
    assert event["tokens_out"] == 0


def test_wrapper_attaches_pylva_metadata_to_response() -> None:
    pylva.init(VALID_KEY, local_mode=True)
    Completions = _install_fake_openai()  # noqa: N806 — class object
    openai_wrapper.try_patch_openai()

    resp = Completions().create(model="gpt-4o-mini", messages=[])
    assert hasattr(resp, "_pylva")
    assert resp._pylva.original_model == "gpt-4o-mini"
    assert resp._pylva.routing_applied is False


def test_wrapper_skips_failure_telemetry_on_intentional_refusal() -> None:
    """PylvaBudgetExceeded is a refusal, not a provider failure."""
    from pylva.core import budget_accumulator as ba
    from pylva.core import rules_cache
    from pylva.errors.budget_exceeded import PylvaBudgetExceeded
    from pylva.wrappers._budget import _period_start_utc

    pylva.init(VALID_KEY, local_mode=True)
    Completions = _install_fake_openai()  # noqa: N806 — class object
    openai_wrapper.try_patch_openai()

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
            Completions().create(model="gpt-4o-mini", messages=[])

    # No FAILURE event was emitted — the buffer stays empty.
    assert telemetry.buffer_size() == 0
