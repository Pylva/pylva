"""Authoritative OpenAI/Anthropic explicit-wrapper contract."""

from __future__ import annotations

import asyncio
import gc
import inspect
import json
import threading
import weakref
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from functools import wraps
from types import SimpleNamespace
from typing import Any

import pytest

import pylva
from pylva.core import control_client, telemetry
from pylva.core.config import _require_config_snapshot
from pylva.core.control_ownership import (
    _register_controlled_reservation,
    current_controlled_attempt,
    current_controlled_operation,
)
from pylva.core.control_schema import (
    BypassedBudgetDecision,
    ReservedBudgetDecision,
    UnavailableBudgetDecision,
)
from pylva.errors.strict_provider import PylvaStrictProviderError
from pylva.wrappers import _controlled_provider as controlled_provider
from pylva.wrappers import (
    wrap_anthropic as public_wrap_anthropic,
)
from pylva.wrappers import (
    wrap_openai as public_wrap_openai,
)
from pylva.wrappers._strict_context import (
    is_strict_provider_dispatch,
    strict_provider_dispatch,
)
from pylva.wrappers.anthropic_controlled import _wrap_anthropic_for_tests as wrap_anthropic
from pylva.wrappers.openai_controlled import _wrap_openai_for_tests as wrap_openai

VALID_KEY = "pv_live_12345678_" + "a" * 32
OTHER_KEY = "pv_live_87654321_" + "b" * 32


def _init(*, mode: str = "enforce", on_unavailable: str = "deny") -> None:
    pylva.init(
        VALID_KEY,
        endpoint="https://unit.invalid",
        local_mode=True,
        control={"mode": mode, "on_unavailable": on_unavailable},
    )
    telemetry._reset_telemetry_for_tests()  # type: ignore[attr-defined]


def _reserved(
    trace_id: str = "44444444-4444-4444-8444-444444444444",
    span_id: str = "55555555-5555-4555-8555-555555555555",
    operation_id: str = "22222222-2222-4222-8222-222222222222",
    reservation_id: str = "33333333-3333-4333-8333-333333333333",
) -> ReservedBudgetDecision:
    decision = ReservedBudgetDecision.model_validate(
        {
            "schema_version": "1.0",
            "decision": "reserved",
            "allowed": True,
            "decision_id": "11111111-1111-4111-8111-111111111111",
            "operation_id": operation_id,
            "reservation_id": reservation_id,
            "state": "reserved",
            "reserved_usd": "1",
            "remaining_usd": "2",
            "expires_at": "2026-07-14T10:00:00.000Z",
            "warnings": [],
        },
        strict=True,
    )
    cfg, generation = _require_config_snapshot()
    assert _register_controlled_reservation(
        decision,
        cfg,
        generation,
        trace_id,
        span_id,
    )
    return decision


def _bypassed(reason: str = "no_applicable_budget") -> BypassedBudgetDecision:
    return BypassedBudgetDecision.model_validate(
        {
            "schema_version": "1.0",
            "decision": "bypassed",
            "allowed": True,
            "decision_id": (
                None
                if reason in {"control_disabled", "shadow_control_unavailable"}
                else "11111111-1111-4111-8111-111111111111"
            ),
            "operation_id": "22222222-2222-4222-8222-222222222222",
            "reason": reason,
            "would_have_denied": (
                True
                if reason == "shadow_would_deny"
                else False
                if reason == "shadow_would_allow"
                else None
            ),
            "warnings": [],
        },
        strict=True,
    )


def _unavailable() -> UnavailableBudgetDecision:
    return UnavailableBudgetDecision.model_validate(
        {
            "schema_version": "1.0",
            "decision": "unavailable",
            "allowed": False,
            "decision_id": None,
            "operation_id": "22222222-2222-4222-8222-222222222222",
            "reason": "control_unavailable",
            "retryable": True,
        },
        strict=True,
    )


class _OpenAIUsage:
    def __init__(
        self,
        *,
        input_tokens: int = 12,
        output_tokens: int = 7,
        cached_tokens: int = 0,
        cache_write_tokens: int = 0,
    ) -> None:
        self.prompt_tokens = input_tokens
        self.completion_tokens = output_tokens
        self.prompt_tokens_details = SimpleNamespace(
            cached_tokens=cached_tokens,
            cache_write_tokens=cache_write_tokens,
        )


class _OpenAIResponse:
    def __init__(self, model: str = "gpt-safe") -> None:
        self.model = model
        self.service_tier = "default"
        self.usage = _OpenAIUsage()
        self.content = "PROVIDER SECRET"


class _AnthropicUsage:
    def __init__(self) -> None:
        self.input_tokens = 14
        self.output_tokens = 9
        self.cache_read_input_tokens = 0
        self.cache_creation_input_tokens = 0
        self.service_tier = "standard"


class _AnthropicResponse:
    def __init__(self, model: str = "claude-safe") -> None:
        self.model = model
        self.usage = _AnthropicUsage()
        self.content = [{"type": "text", "text": "PROVIDER SECRET"}]


class _SyncCreate:
    def __init__(self, response: object, *, error: BaseException | None = None) -> None:
        self.response = response
        self.error = error
        self.calls: list[dict[str, Any]] = []

    def create(self, **kwargs: Any) -> object:
        self.calls.append(kwargs)
        if self.error is not None:
            raise self.error
        return self.response


class _AsyncCreate(_SyncCreate):
    async def create(self, **kwargs: Any) -> object:
        self.calls.append(kwargs)
        if self.error is not None:
            raise self.error
        return self.response


class _SdkDecoratedAsyncCreate(_SyncCreate):
    """Match generated provider SDKs whose sync-looking wrapper returns a coroutine."""

    async def _async_create(self, **kwargs: Any) -> object:
        self.calls.append(kwargs)
        if self.error is not None:
            raise self.error
        return self.response

    @wraps(_async_create)
    def create(self, **kwargs: Any) -> object:
        return self._async_create(**kwargs)


class _OpenAIDefaultHttpClient:
    def __init__(self) -> None:
        self._transport = object()


_OpenAIDefaultHttpClient.__name__ = "SyncHttpxClientWrapper"
_OpenAIDefaultHttpClient.__module__ = "openai._base_client"


class _AnthropicDefaultHttpClient:
    def __init__(self) -> None:
        self._transport = object()


_AnthropicDefaultHttpClient.__name__ = "SyncHttpxClientWrapper"
_AnthropicDefaultHttpClient.__module__ = "anthropic._base_client"


class _OpenAIClient:
    def __init__(self, resource: object, *, max_retries: int = 0) -> None:
        self.max_retries = max_retries
        self.base_url = "https://api.openai.com/v1/"
        self._custom_headers: dict[str, str] = {}
        self._custom_query: dict[str, str] = {}
        self.default_headers: dict[str, str] = {}
        self.default_query: dict[str, str] = {}
        self._client = _OpenAIDefaultHttpClient()
        self.chat = SimpleNamespace(completions=resource)
        resource._client = self

    def with_options(self, *, max_retries: int) -> _OpenAIClient:
        return _OpenAIClient(self.chat.completions, max_retries=max_retries)


class _AnthropicClient:
    def __init__(self, resource: object, *, max_retries: int = 0) -> None:
        self.max_retries = max_retries
        self.base_url = "https://api.anthropic.com"
        self._custom_headers: dict[str, str] = {}
        self._custom_query: dict[str, str] = {}
        self.default_headers: dict[str, str] = {}
        self.default_query: dict[str, str] = {}
        self._client = _AnthropicDefaultHttpClient()
        self.messages = resource
        resource._client = self

    def with_options(self, *, max_retries: int) -> _AnthropicClient:
        return _AnthropicClient(self.messages, max_retries=max_retries)


def _openai_kwargs(**overrides: Any) -> dict[str, Any]:
    return {
        "model": "gpt-safe",
        "messages": [{"role": "user", "content": "TOP SECRET"}],
        "max_completion_tokens": 32,
        **overrides,
    }


def _oversized_zero_usage() -> dict[str, int]:
    return {f"future_zero_{index}": 0 for index in range(257)}


def _anthropic_kwargs(**overrides: Any) -> dict[str, Any]:
    return {
        "model": "claude-safe",
        "messages": [{"role": "user", "content": "TOP SECRET"}],
        "max_tokens": 32,
        **overrides,
    }


def test_controlled_provider_surface_is_public_and_typed() -> None:
    assert pylva.wrap_openai is public_wrap_openai
    assert pylva.wrap_anthropic is public_wrap_anthropic
    assert pylva.PylvaStrictProviderError is PylvaStrictProviderError
    assert pylva.PYLVA_STRICT_PROVIDER_UNSUPPORTED_CODE == "strict_provider_unsupported"
    assert callable(pylva.current_controlled_attempt)


def test_all_uncontrolled_provider_client_and_resource_surfaces_fail_closed() -> None:
    openai_client = wrap_openai(_OpenAIClient(_SyncCreate(_OpenAIResponse())))
    anthropic_client = wrap_anthropic(_AnthropicClient(_SyncCreate(_AnthropicResponse())))

    unsupported = [
        lambda: openai_client.responses,
        lambda: openai_client.audio,
        lambda: openai_client.batches,
        lambda: openai_client.chat.with_raw_response,
        lambda: openai_client.chat.completions.parse,
        lambda: openai_client.chat.completions.stream,
        lambda: anthropic_client.beta,
        lambda: anthropic_client.completions,
        lambda: anthropic_client.messages.batches,
        lambda: anthropic_client.messages.count_tokens,
        lambda: anthropic_client.messages.parse,
        lambda: anthropic_client.messages.with_raw_response,
    ]
    for access in unsupported:
        with pytest.raises(PylvaStrictProviderError) as raised:
            access()
        assert raised.value.reason == "unsupported_pricing_feature"


@pytest.mark.parametrize("wrapper", [wrap_openai, wrap_anthropic])
def test_hostile_client_configuration_error_is_sanitized_before_reservation(
    wrapper: Any,
) -> None:
    class HostileClient:
        @property
        def max_retries(self) -> int:
            raise RuntimeError("PRIVATE CLIENT CONFIGURATION")

    with pytest.raises(PylvaStrictProviderError) as raised:
        wrapper(HostileClient())

    assert raised.value.reason == "provider_retries_enabled"
    assert "PRIVATE" not in str(raised.value)


@pytest.mark.asyncio
async def test_generated_sdk_decorated_async_methods_are_classified_before_dispatch() -> None:
    _init(mode="legacy")

    openai_resource = _SdkDecoratedAsyncCreate(_OpenAIResponse())
    openai_client = wrap_openai(_OpenAIClient(openai_resource))
    assert inspect.iscoroutinefunction(openai_client.chat.completions.create)
    openai_result = await openai_client.chat.completions.create(**_openai_kwargs())

    anthropic_resource = _SdkDecoratedAsyncCreate(_AnthropicResponse())
    anthropic_client = wrap_anthropic(_AnthropicClient(anthropic_resource))
    assert inspect.iscoroutinefunction(anthropic_client.messages.create)
    anthropic_result = await anthropic_client.messages.create(**_anthropic_kwargs())

    assert isinstance(openai_result, _OpenAIResponse)
    assert isinstance(anthropic_result, _AnthropicResponse)
    assert len(openai_resource.calls) == 1
    assert len(anthropic_resource.calls) == 1


@pytest.mark.asyncio
async def test_strict_dispatch_marker_expires_in_inherited_child_task() -> None:
    inherited = asyncio.Event()
    inspect_after_exit = asyncio.Event()

    async def child() -> bool:
        inherited.set()
        await inspect_after_exit.wait()
        return is_strict_provider_dispatch("openai", "gpt-safe")

    with strict_provider_dispatch("openai", "gpt-safe"):
        task = asyncio.create_task(child())
        await inherited.wait()
        assert is_strict_provider_dispatch("openai", "gpt-safe")

    inspect_after_exit.set()
    assert await task is False


def test_openai_reserves_content_free_bound_immediately_before_dispatch_and_commits(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()
    order: list[str] = []
    reservation_bodies: list[dict[str, Any]] = []
    commits: list[tuple[str, dict[str, Any]]] = []

    def reserve(body: dict[str, Any]) -> ReservedBudgetDecision:
        order.append("reserve")
        reservation_bodies.append(body)
        return _reserved()

    resource = _SyncCreate(_OpenAIResponse())
    original_create = resource.create

    def create(**kwargs: Any) -> object:
        order.append("provider")
        return original_create(**kwargs)

    resource.create = create  # type: ignore[method-assign]
    monkeypatch.setattr(control_client, "reserve_usage_sync", reserve)
    monkeypatch.setattr(
        control_client,
        "commit_usage_sync",
        lambda reservation_id, body: commits.append((reservation_id, body)),
    )

    result = wrap_openai(_OpenAIClient(resource)).chat.completions.create(**_openai_kwargs())

    assert isinstance(result, _OpenAIResponse)
    assert order == ["reserve", "provider"]
    assert len(commits) == 1
    assert commits[0][1]["actual_input_tokens"] == 12
    assert commits[0][1]["actual_output_tokens"] == 7
    wire = json.dumps(reservation_bodies)
    assert "TOP SECRET" not in wire
    assert "messages" not in wire
    assert reservation_bodies[0]["estimated_input_tokens"] > 0
    provider_request = resource.calls[0]
    assert provider_request["service_tier"] == "default"
    assert provider_request["n"] == 1
    assert provider_request["store"] is False


@pytest.mark.asyncio
async def test_anthropic_async_reserves_and_commits_exact_standard_usage(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()
    bodies: list[dict[str, Any]] = []
    commits: list[dict[str, Any]] = []

    async def reserve(body: dict[str, Any]) -> ReservedBudgetDecision:
        bodies.append(body)
        return _reserved()

    async def commit(_reservation_id: str, body: dict[str, Any]) -> None:
        commits.append(body)

    monkeypatch.setattr(control_client, "reserve_usage", reserve)
    monkeypatch.setattr(control_client, "commit_usage", commit)
    resource = _AsyncCreate(_AnthropicResponse())
    client = wrap_anthropic(_AnthropicClient(resource))

    result = await client.messages.create(**_anthropic_kwargs())

    assert isinstance(result, _AnthropicResponse)
    assert bodies[0]["estimated_input_tokens"] > 0
    assert bodies[0]["max_output_tokens"] == 32
    assert commits == [
        {
            "kind": "llm",
            "actual_input_tokens": 14,
            "actual_output_tokens": 9,
            "status": "success",
            "latency_ms": commits[0]["latency_ms"],
            "stream_aborted": False,
        }
    ]
    assert resource.calls[0]["service_tier"] == "standard_only"


@pytest.mark.asyncio
async def test_openai_async_audio_usage_preserves_response_unresolved(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()
    response = _OpenAIResponse()
    response.usage.prompt_tokens_details.audio_tokens = 1
    commits: list[object] = []

    async def reserve(_body: dict[str, Any]) -> ReservedBudgetDecision:
        return _reserved()

    async def commit(*args: object) -> None:
        commits.append(args)

    monkeypatch.setattr(control_client, "reserve_usage", reserve)
    monkeypatch.setattr(control_client, "commit_usage", commit)
    result = await wrap_openai(_OpenAIClient(_AsyncCreate(response))).chat.completions.create(
        **_openai_kwargs()
    )

    assert result is response
    assert commits == []


@pytest.mark.asyncio
@pytest.mark.parametrize("mutation", ["cache_creation", "unknown_paid"])
async def test_anthropic_async_paid_usage_preserves_response_unresolved(
    monkeypatch: pytest.MonkeyPatch,
    mutation: str,
) -> None:
    _init()
    response = _AnthropicResponse()
    if mutation == "cache_creation":
        response.usage.cache_creation = SimpleNamespace(
            ephemeral_1h_input_tokens=1,
            ephemeral_5m_input_tokens=0,
        )
    else:
        response.usage.unknown_paid_usage = {"premium_units": 1}
    commits: list[object] = []

    async def reserve(_body: dict[str, Any]) -> ReservedBudgetDecision:
        return _reserved()

    async def commit(*args: object) -> None:
        commits.append(args)

    monkeypatch.setattr(control_client, "reserve_usage", reserve)
    monkeypatch.setattr(control_client, "commit_usage", commit)
    result = await wrap_anthropic(_AnthropicClient(_AsyncCreate(response))).messages.create(
        **_anthropic_kwargs()
    )

    assert result is response
    assert commits == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "case",
    [
        "openai_oversized_top",
        "openai_oversized_detail",
        "openai_total_mismatch",
        "anthropic_oversized_top",
        "anthropic_oversized_detail",
        "anthropic_thinking_overflow",
    ],
)
async def test_async_oversized_or_contradictory_usage_preserves_response_unresolved(
    monkeypatch: pytest.MonkeyPatch,
    case: str,
) -> None:
    _init()
    commits: list[object] = []

    async def reserve(_body: dict[str, Any]) -> ReservedBudgetDecision:
        return _reserved()

    async def commit(*args: object) -> None:
        commits.append(args)

    monkeypatch.setattr(control_client, "reserve_usage", reserve)
    monkeypatch.setattr(control_client, "commit_usage", commit)
    if case.startswith("openai"):
        response: Any = _OpenAIResponse()
        if case == "openai_oversized_top":
            response.usage = {
                "prompt_tokens": 12,
                "completion_tokens": 7,
                **_oversized_zero_usage(),
            }
        elif case == "openai_oversized_detail":
            response.usage.completion_tokens_details = _oversized_zero_usage()
        else:
            response.usage.total_tokens = 20
        result = await wrap_openai(_OpenAIClient(_AsyncCreate(response))).chat.completions.create(
            **_openai_kwargs()
        )
    else:
        response = _AnthropicResponse()
        if case == "anthropic_oversized_top":
            response.usage = {
                "input_tokens": 14,
                "output_tokens": 9,
                **_oversized_zero_usage(),
            }
        elif case == "anthropic_oversized_detail":
            response.usage.output_tokens_details = _oversized_zero_usage()
        else:
            response.usage.output_tokens_details = SimpleNamespace(thinking_tokens=10)
        result = await wrap_anthropic(_AnthropicClient(_AsyncCreate(response))).messages.create(
            **_anthropic_kwargs()
        )

    assert result is response
    assert commits == []


@pytest.mark.parametrize(
    ("mode", "on_unavailable", "decision"),
    [
        ("legacy", "allow", _bypassed("control_disabled")),
        ("shadow", "allow", _bypassed("shadow_would_allow")),
        ("enforce", "deny", _bypassed("no_applicable_budget")),
        ("enforce", "allow", _unavailable()),
    ],
)
def test_rollout_bypass_and_allowed_unavailable_dispatch_with_one_legacy_event(
    monkeypatch: pytest.MonkeyPatch,
    mode: str,
    on_unavailable: str,
    decision: object,
) -> None:
    _init(mode=mode, on_unavailable=on_unavailable)
    resource = _SyncCreate(_OpenAIResponse())
    reserve_calls = 0

    def reserve(_body: dict[str, Any]) -> object:
        nonlocal reserve_calls
        reserve_calls += 1
        return decision

    monkeypatch.setattr(control_client, "reserve_usage_sync", reserve)
    client = wrap_openai(_OpenAIClient(resource))
    client.chat.completions.create(**_openai_kwargs())

    assert reserve_calls == 1
    assert len(resource.calls) == 1
    assert telemetry.buffer_size() == 1
    event = telemetry._state.buffer[0]  # type: ignore[attr-defined]
    assert event["tokens_in"] == 12
    assert event["tokens_out"] == 7
    assert "TOP SECRET" not in json.dumps(event)


def test_denial_or_fail_closed_uncertainty_makes_zero_provider_calls(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()
    resource = _SyncCreate(_OpenAIResponse())
    refusal = RuntimeError("typed refusal sentinel")
    monkeypatch.setattr(
        control_client,
        "reserve_usage_sync",
        lambda _body: (_ for _ in ()).throw(refusal),
    )

    with pytest.raises(RuntimeError, match="typed refusal sentinel"):
        wrap_openai(_OpenAIClient(resource)).chat.completions.create(**_openai_kwargs())
    assert resource.calls == []
    assert telemetry.buffer_size() == 0


def test_lost_commit_ack_returns_success_and_never_emits_legacy_duplicate(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()
    resource = _SyncCreate(_OpenAIResponse())
    monkeypatch.setattr(control_client, "reserve_usage_sync", lambda _body: _reserved())
    monkeypatch.setattr(
        control_client,
        "commit_usage_sync",
        lambda *_args: (_ for _ in ()).throw(RuntimeError("lost ack")),
    )

    result = wrap_openai(_OpenAIClient(resource)).chat.completions.create(**_openai_kwargs())

    assert isinstance(result, _OpenAIResponse)
    assert telemetry.buffer_size() == 0


@pytest.mark.parametrize(
    "response",
    [
        SimpleNamespace(
            service_tier="default",
            usage=_OpenAIUsage(),
        ),
        _OpenAIResponse(model="gpt-different-priced-model"),
    ],
)
def test_missing_or_different_response_model_returns_result_but_never_commits(
    monkeypatch: pytest.MonkeyPatch,
    response: object,
) -> None:
    _init()
    commits: list[object] = []
    monkeypatch.setattr(control_client, "reserve_usage_sync", lambda _body: _reserved())
    monkeypatch.setattr(control_client, "commit_usage_sync", lambda *args: commits.append(args))

    result = wrap_openai(_OpenAIClient(_SyncCreate(response))).chat.completions.create(
        **_openai_kwargs()
    )

    assert result is response
    assert commits == []
    assert telemetry.buffer_size() == 0


def test_legacy_telemetry_uses_observed_provider_model() -> None:
    _init(mode="legacy", on_unavailable="allow")
    response = _OpenAIResponse(model="gpt-returned-priced-model")

    result = wrap_openai(_OpenAIClient(_SyncCreate(response))).chat.completions.create(
        **_openai_kwargs(model="gpt-request-alias")
    )

    assert result is response
    assert telemetry.buffer_size() == 1
    event = telemetry._state.buffer[0]  # type: ignore[attr-defined]
    assert event["model"] == "gpt-returned-priced-model"


@pytest.mark.parametrize(
    "kwargs",
    [
        _openai_kwargs(max_completion_tokens=None),
        _openai_kwargs(n=2),
        _openai_kwargs(service_tier="flex"),
        _openai_kwargs(prompt_cache_key="cache-me"),
        _openai_kwargs(
            messages=[
                {
                    "role": "user",
                    "content": [{"type": "image_url", "image_url": {"url": "https://x"}}],
                }
            ]
        ),
        _openai_kwargs(
            tools=[{"type": "web_search_preview"}],
        ),
        _openai_kwargs(messages=[{"role": "user", "content": "x" * 2_000}]),
    ],
)
def test_openai_unpriceable_features_refuse_before_reserve_or_provider(
    monkeypatch: pytest.MonkeyPatch,
    kwargs: dict[str, Any],
) -> None:
    _init()
    resource = _SyncCreate(_OpenAIResponse())
    reserve_calls = 0

    def reserve(_body: dict[str, Any]) -> object:
        nonlocal reserve_calls
        reserve_calls += 1
        return _reserved()

    monkeypatch.setattr(control_client, "reserve_usage_sync", reserve)
    with pytest.raises(PylvaStrictProviderError):
        wrap_openai(_OpenAIClient(resource)).chat.completions.create(**kwargs)
    assert reserve_calls == 0
    assert resource.calls == []


@pytest.mark.parametrize(
    "kwargs",
    [
        _anthropic_kwargs(max_tokens=0),
        _anthropic_kwargs(service_tier="auto"),
        _anthropic_kwargs(
            messages=[
                {
                    "role": "user",
                    "content": [{"type": "text", "text": "x", "cache_control": {}}],
                }
            ]
        ),
        _anthropic_kwargs(
            tools=[
                {
                    "type": "web_search_20250305",
                    "name": "web_search",
                    "input_schema": {"type": "object"},
                }
            ]
        ),
        _anthropic_kwargs(messages=[{"role": "user", "content": "x" * 190_000}]),
    ],
)
def test_anthropic_unpriceable_features_refuse_before_reserve_or_provider(
    monkeypatch: pytest.MonkeyPatch,
    kwargs: dict[str, Any],
) -> None:
    _init()
    resource = _SyncCreate(_AnthropicResponse())
    reserve_calls = 0

    def reserve(_body: dict[str, Any]) -> object:
        nonlocal reserve_calls
        reserve_calls += 1
        return _reserved()

    monkeypatch.setattr(control_client, "reserve_usage_sync", reserve)
    with pytest.raises(PylvaStrictProviderError):
        wrap_anthropic(_AnthropicClient(resource)).messages.create(**kwargs)
    assert reserve_calls == 0
    assert resource.calls == []


def test_provider_retry_configuration_is_forced_to_zero() -> None:
    _init(mode="legacy", on_unavailable="allow")
    openai_resource = _SyncCreate(_OpenAIResponse())
    anthropic_resource = _SyncCreate(_AnthropicResponse())
    assert wrap_openai(_OpenAIClient(openai_resource, max_retries=2)).max_retries == 0
    assert wrap_anthropic(_AnthropicClient(anthropic_resource, max_retries=3)).max_retries == 0


def test_caller_owned_fallback_reserves_each_actual_attempt_with_fresh_identity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()
    reservation_bodies: list[dict[str, Any]] = []
    commits: list[str] = []

    def reserve(body: dict[str, Any]) -> ReservedBudgetDecision:
        reservation_bodies.append(dict(body))
        index = len(reservation_bodies)
        return _reserved(
            body["trace_id"],
            body["span_id"],
            body["operation_id"],
            f"33333333-3333-4333-8333-{index:012d}",
        )

    monkeypatch.setattr(control_client, "reserve_usage_sync", reserve)
    monkeypatch.setattr(
        control_client,
        "commit_usage_sync",
        lambda reservation_id, _body: commits.append(reservation_id),
    )
    openai_resource = _SyncCreate(
        _OpenAIResponse(),
        error=RuntimeError("ambiguous OpenAI attempt"),
    )
    anthropic_resource = _SyncCreate(_AnthropicResponse())
    openai = wrap_openai(_OpenAIClient(openai_resource, max_retries=4))
    anthropic = wrap_anthropic(_AnthropicClient(anthropic_resource, max_retries=5))

    with pytest.raises(RuntimeError, match="ambiguous OpenAI attempt"):
        openai.chat.completions.create(**_openai_kwargs())
    result = anthropic.messages.create(**_anthropic_kwargs())

    assert isinstance(result, _AnthropicResponse)
    assert openai.max_retries == anthropic.max_retries == 0
    assert [(body["provider"], body["model"]) for body in reservation_bodies] == [
        ("openai", "gpt-safe"),
        ("anthropic", "claude-safe"),
    ]
    assert len({body["operation_id"] for body in reservation_bodies}) == 2
    assert len(openai_resource.calls) == len(anthropic_resource.calls) == 1
    # The ambiguous first attempt remains unresolved. Only the independently
    # authorized fallback with exact evidence is committed.
    assert commits == ["33333333-3333-4333-8333-000000000002"]


def test_missing_usage_evidence_leaves_reservation_unresolved(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()
    response = _OpenAIResponse()
    response.usage = None
    resource = _SyncCreate(response)
    commits: list[object] = []
    monkeypatch.setattr(control_client, "reserve_usage_sync", lambda _body: _reserved())
    monkeypatch.setattr(control_client, "commit_usage_sync", lambda *args: commits.append(args))

    result = wrap_openai(_OpenAIClient(resource)).chat.completions.create(**_openai_kwargs())

    assert result is response
    assert commits == []
    assert telemetry.buffer_size() == 0


@pytest.mark.parametrize(
    "mutation",
    [
        "cache_write",
        "prompt_audio",
        "completion_audio",
        "unknown_paid",
        "total_mismatch",
        "input_alias_mismatch",
        "output_alias_mismatch",
        "completion_detail_overflow",
        "openai_oversized_top",
        "openai_oversized_detail",
        "tier",
        "model",
        "anthropic_cache",
        "anthropic_cache_detail",
        "anthropic_unknown_paid",
        "anthropic_thinking_overflow",
        "anthropic_oversized_top",
        "anthropic_oversized_detail",
        "server_tool",
    ],
)
def test_conflicting_post_provider_pricing_evidence_never_exactly_commits(
    monkeypatch: pytest.MonkeyPatch,
    mutation: str,
) -> None:
    _init()
    if mutation in {
        "cache_write",
        "prompt_audio",
        "completion_audio",
        "unknown_paid",
        "total_mismatch",
        "input_alias_mismatch",
        "output_alias_mismatch",
        "completion_detail_overflow",
        "openai_oversized_top",
        "openai_oversized_detail",
        "tier",
        "model",
    }:
        response: Any = _OpenAIResponse()
        if mutation == "cache_write":
            response.usage.prompt_tokens_details.cache_write_tokens = 1
        elif mutation == "prompt_audio":
            response.usage.prompt_tokens_details.audio_tokens = 1
        elif mutation == "completion_audio":
            response.usage.completion_tokens_details = SimpleNamespace(
                audio_tokens=1,
                reasoning_tokens=2,
            )
        elif mutation == "unknown_paid":
            response.usage.unknown_paid_usage = {"premium_units": 1}
        elif mutation == "total_mismatch":
            response.usage.total_tokens = 20
        elif mutation == "input_alias_mismatch":
            response.usage.input_tokens = 13
        elif mutation == "output_alias_mismatch":
            response.usage.output_tokens = 8
        elif mutation == "completion_detail_overflow":
            response.usage.completion_tokens_details = SimpleNamespace(reasoning_tokens=8)
        elif mutation == "openai_oversized_top":
            response.usage = {
                "prompt_tokens": 12,
                "completion_tokens": 7,
                **_oversized_zero_usage(),
            }
        elif mutation == "openai_oversized_detail":
            response.usage.completion_tokens_details = _oversized_zero_usage()
        elif mutation == "tier":
            response.service_tier = "priority"
        else:
            response.model = "gpt-safe-super-premium"
        client: Any = wrap_openai(_OpenAIClient(_SyncCreate(response)))

        def call() -> object:
            return client.chat.completions.create(**_openai_kwargs())

    else:
        response = _AnthropicResponse()
        if mutation == "anthropic_cache":
            response.usage.cache_read_input_tokens = 1
        elif mutation == "anthropic_cache_detail":
            response.usage.cache_creation = SimpleNamespace(
                ephemeral_1h_input_tokens=0,
                ephemeral_5m_input_tokens=1,
            )
        elif mutation == "anthropic_unknown_paid":
            response.usage.unknown_paid_usage = {"premium_units": 1}
        elif mutation == "anthropic_thinking_overflow":
            response.usage.output_tokens_details = SimpleNamespace(thinking_tokens=10)
        elif mutation == "anthropic_oversized_top":
            response.usage = {
                "input_tokens": 14,
                "output_tokens": 9,
                **_oversized_zero_usage(),
            }
        elif mutation == "anthropic_oversized_detail":
            response.usage.output_tokens_details = _oversized_zero_usage()
        else:
            response.usage.server_tool_use = {"web_search_requests": 1}
        client = wrap_anthropic(_AnthropicClient(_SyncCreate(response)))

        def call() -> object:
            return client.messages.create(**_anthropic_kwargs())

    commits: list[object] = []
    monkeypatch.setattr(control_client, "reserve_usage_sync", lambda _body: _reserved())
    monkeypatch.setattr(control_client, "commit_usage_sync", lambda *args: commits.append(args))

    assert call() is response
    assert commits == []


def test_documented_openai_base_detail_counts_still_commit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()
    response = _OpenAIResponse()
    response.usage.total_tokens = 19
    response.usage.prompt_tokens_details.audio_tokens = 0
    response.usage.completion_tokens_details = SimpleNamespace(
        accepted_prediction_tokens=1,
        audio_tokens=0,
        reasoning_tokens=2,
        rejected_prediction_tokens=1,
    )
    commits: list[object] = []
    monkeypatch.setattr(control_client, "reserve_usage_sync", lambda _body: _reserved())
    monkeypatch.setattr(control_client, "commit_usage_sync", lambda *args: commits.append(args))

    result = wrap_openai(_OpenAIClient(_SyncCreate(response))).chat.completions.create(
        **_openai_kwargs()
    )

    assert result is response
    assert len(commits) == 1


def test_documented_anthropic_base_and_nonbilling_usage_still_commit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()
    response = _AnthropicResponse()
    response.usage.inference_geo = "us"
    response.usage.output_tokens_details = SimpleNamespace(thinking_tokens=3)
    response.usage.future_zero_usage = {"units": 0}
    commits: list[object] = []
    monkeypatch.setattr(control_client, "reserve_usage_sync", lambda _body: _reserved())
    monkeypatch.setattr(control_client, "commit_usage_sync", lambda *args: commits.append(args))

    result = wrap_anthropic(_AnthropicClient(_SyncCreate(response))).messages.create(
        **_anthropic_kwargs()
    )

    assert result is response
    assert len(commits) == 1


def test_subthreshold_request_can_settle_when_optional_cache_and_tier_fields_are_absent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()
    response = _OpenAIResponse()
    del response.usage.prompt_tokens_details.cached_tokens
    del response.usage.prompt_tokens_details.cache_write_tokens
    del response.service_tier
    commits: list[object] = []
    monkeypatch.setattr(control_client, "reserve_usage_sync", lambda _body: _reserved())
    monkeypatch.setattr(control_client, "commit_usage_sync", lambda *args: commits.append(args))

    result = wrap_openai(_OpenAIClient(_SyncCreate(response))).chat.completions.create(
        **_openai_kwargs()
    )

    assert result is response
    assert len(commits) == 1


def test_hostile_post_provider_getters_are_nonthrowing_and_leave_unresolved(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()

    class HostileResponse:
        @property
        def usage(self) -> object:
            raise RuntimeError("hostile usage getter")

        @property
        def model(self) -> object:
            raise RuntimeError("hostile model getter")

    response = HostileResponse()
    commits: list[object] = []
    monkeypatch.setattr(control_client, "reserve_usage_sync", lambda _body: _reserved())
    monkeypatch.setattr(control_client, "commit_usage_sync", lambda *args: commits.append(args))

    result = wrap_openai(_OpenAIClient(_SyncCreate(response))).chat.completions.create(
        **_openai_kwargs()
    )

    assert result is response
    assert commits == []


class _SyncStream:
    def __init__(self, items: list[object], *, fail_after: int | None = None) -> None:
        self._items = iter(items)
        self._index = 0
        self._fail_after = fail_after
        self.closed = False
        self.close_calls = 0

    def __iter__(self) -> _SyncStream:
        return self

    def __next__(self) -> object:
        if self._fail_after is not None and self._index >= self._fail_after:
            raise RuntimeError("stream failed")
        self._index += 1
        return next(self._items)

    def close(self) -> None:
        self.close_calls += 1
        self.closed = True

    def __enter__(self) -> _SyncStream:
        return self

    def __exit__(self, *_args: object) -> bool:
        self.close()
        return False


class _AsyncStream:
    def __init__(self, items: list[object]) -> None:
        self._items = iter(items)
        self.closed = False
        self.close_calls = 0

    def __aiter__(self) -> _AsyncStream:
        return self

    async def __anext__(self) -> object:
        try:
            return next(self._items)
        except StopIteration:
            raise StopAsyncIteration from None

    async def close(self) -> None:
        self.close_calls += 1
        self.closed = True

    async def aclose(self) -> None:
        await self.close()

    async def __aenter__(self) -> _AsyncStream:
        return self

    async def __aexit__(self, *_args: object) -> bool:
        await self.close()
        return False


class _AnthropicParsedSyncStream(_SyncStream):
    def __init__(self) -> None:
        event = SimpleNamespace(
            type="content_block_delta",
            delta=SimpleNamespace(type="text_delta", text="hello"),
        )
        super().__init__([event])
        self.current_message_snapshot = _AnthropicResponse()

    def get_final_message(self) -> _AnthropicResponse:
        return self.current_message_snapshot

    def get_final_text(self) -> str:
        return "hello"


class _AnthropicParsedAsyncStream(_AsyncStream):
    def __init__(self) -> None:
        event = SimpleNamespace(
            type="content_block_delta",
            delta=SimpleNamespace(type="text_delta", text="hello"),
        )
        super().__init__([event])
        self.current_message_snapshot = _AnthropicResponse()

    async def get_final_message(self) -> _AnthropicResponse:
        return self.current_message_snapshot

    async def get_final_text(self) -> str:
        return "hello"


class _AccessorOnlySyncStream(_SyncStream):
    def __init__(self) -> None:
        super().__init__([SimpleNamespace(type="content_block_delta", delta=None)])

    def get_final_message(self) -> _AnthropicResponse:
        return _AnthropicResponse()


class _SyncNativeManager:
    def __init__(self, stream: _AnthropicParsedSyncStream) -> None:
        self.stream = stream
        self.entered = False

    def __enter__(self) -> _AnthropicParsedSyncStream:
        self.entered = True
        return self.stream

    def __exit__(self, *_args: object) -> bool:
        self.stream.close()
        return False


class _AsyncNativeManager:
    def __init__(self, stream: _AnthropicParsedAsyncStream) -> None:
        self.stream = stream
        self.entered = False

    async def __aenter__(self) -> _AnthropicParsedAsyncStream:
        self.entered = True
        return self.stream

    async def __aexit__(self, *_args: object) -> bool:
        await self.stream.aclose()
        return False


class _SyncAnthropicNativeResource(_SyncCreate):
    def __init__(self) -> None:
        super().__init__(_AnthropicResponse())
        self.stream_calls: list[dict[str, Any]] = []
        self.last_manager: _SyncNativeManager | None = None

    def stream(self, **kwargs: Any) -> _SyncNativeManager:
        self.stream_calls.append(kwargs)
        self.last_manager = _SyncNativeManager(_AnthropicParsedSyncStream())
        return self.last_manager


class _AsyncAnthropicNativeResource(_AsyncCreate):
    def __init__(self) -> None:
        super().__init__(_AnthropicResponse())
        self.stream_calls: list[dict[str, Any]] = []
        self.last_manager: _AsyncNativeManager | None = None

    def stream(self, **kwargs: Any) -> _AsyncNativeManager:
        self.stream_calls.append(kwargs)
        self.last_manager = _AsyncNativeManager(_AnthropicParsedAsyncStream())
        return self.last_manager


def _openai_final_chunk() -> object:
    return SimpleNamespace(model="gpt-safe", service_tier="default", usage=_OpenAIUsage())


def test_sync_stream_commits_only_after_terminal_usage_and_early_close_is_unresolved(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()
    commits: list[dict[str, Any]] = []
    monkeypatch.setattr(control_client, "reserve_usage_sync", lambda _body: _reserved())
    monkeypatch.setattr(
        control_client,
        "commit_usage_sync",
        lambda _reservation, body: commits.append(body),
    )

    complete = _SyncStream([SimpleNamespace(usage=None), _openai_final_chunk()])
    complete_resource = _SyncCreate(complete)
    wrapped = wrap_openai(_OpenAIClient(complete_resource), heartbeat_interval_seconds=None)
    stream = wrapped.chat.completions.create(**_openai_kwargs(stream=True))
    assert commits == []
    assert len(list(stream)) == 2
    assert len(commits) == 1

    commits.clear()
    early = _SyncStream([SimpleNamespace(usage=None), _openai_final_chunk()])
    early_resource = _SyncCreate(early)
    stream = wrap_openai(
        _OpenAIClient(early_resource), heartbeat_interval_seconds=None
    ).chat.completions.create(**_openai_kwargs(stream=True))
    next(stream)
    stream.close()
    assert early.closed
    assert commits == []


@pytest.mark.parametrize(
    "usage_counts",
    [
        [(12, 1), (13, 2)],
        [(12, 2), (12, 1)],
    ],
)
def test_conflicting_stream_usage_evidence_never_commits(
    monkeypatch: pytest.MonkeyPatch,
    usage_counts: list[tuple[int, int]],
) -> None:
    _init()
    commits: list[object] = []
    monkeypatch.setattr(control_client, "reserve_usage_sync", lambda _body: _reserved())
    monkeypatch.setattr(control_client, "commit_usage_sync", lambda *args: commits.append(args))
    chunks = [
        SimpleNamespace(
            model="gpt-safe",
            service_tier="default",
            usage=_OpenAIUsage(input_tokens=input_tokens, output_tokens=output_tokens),
        )
        for input_tokens, output_tokens in usage_counts
    ]

    stream = wrap_openai(_OpenAIClient(_SyncCreate(_SyncStream(chunks)))).chat.completions.create(
        **_openai_kwargs(stream=True)
    )

    assert len(list(stream)) == 2
    assert commits == []


@pytest.mark.parametrize(
    "provider",
    [
        "openai",
        "openai_oversized",
        "openai_total_mismatch",
        "anthropic_cache",
        "anthropic_unknown",
        "anthropic_oversized",
        "anthropic_thinking_overflow",
    ],
)
def test_sync_stream_paid_usage_preserves_terminal_chunk_unresolved(
    monkeypatch: pytest.MonkeyPatch,
    provider: str,
) -> None:
    _init()
    commits: list[object] = []
    monkeypatch.setattr(control_client, "reserve_usage_sync", lambda _body: _reserved())
    monkeypatch.setattr(control_client, "commit_usage_sync", lambda *args: commits.append(args))
    if provider.startswith("openai"):
        terminal = _openai_final_chunk()
        if provider == "openai":
            terminal.usage.completion_tokens_details = SimpleNamespace(audio_tokens=1)
        elif provider == "openai_oversized":
            terminal.usage.completion_tokens_details = _oversized_zero_usage()
        else:
            terminal.usage.total_tokens = 20
        stream = wrap_openai(
            _OpenAIClient(_SyncCreate(_SyncStream([terminal]))),
            heartbeat_interval_seconds=None,
        ).chat.completions.create(**_openai_kwargs(stream=True))
    else:
        terminal = _AnthropicResponse()
        if provider == "anthropic_cache":
            terminal.usage.cache_creation = SimpleNamespace(
                ephemeral_1h_input_tokens=0,
                ephemeral_5m_input_tokens=1,
            )
        elif provider == "anthropic_unknown":
            terminal.usage.unknown_paid_usage = {"premium_units": 1}
        elif provider == "anthropic_oversized":
            terminal.usage.output_tokens_details = _oversized_zero_usage()
        else:
            terminal.usage.output_tokens_details = SimpleNamespace(thinking_tokens=10)
        stream = wrap_anthropic(
            _AnthropicClient(_SyncCreate(_SyncStream([terminal]))),
            heartbeat_interval_seconds=None,
        ).messages.create(**_anthropic_kwargs(stream=True))

    seen = list(stream)
    assert len(seen) == 1
    assert seen[0] is terminal
    assert commits == []


def test_hostile_openai_stream_detail_is_preserved_and_poisoned(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()

    class HostileCompletionDetails:
        @property
        def audio_tokens(self) -> int:
            raise RuntimeError("hostile audio getter")

    terminal = _openai_final_chunk()
    terminal.usage.completion_tokens_details = HostileCompletionDetails()
    commits: list[object] = []
    monkeypatch.setattr(control_client, "reserve_usage_sync", lambda _body: _reserved())
    monkeypatch.setattr(control_client, "commit_usage_sync", lambda *args: commits.append(args))
    stream = wrap_openai(
        _OpenAIClient(_SyncCreate(_SyncStream([terminal]))),
        heartbeat_interval_seconds=None,
    ).chat.completions.create(**_openai_kwargs(stream=True))

    seen = list(stream)
    assert seen[0] is terminal
    assert commits == []


@pytest.mark.asyncio
async def test_async_stream_context_and_terminal_settlement(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()
    commits: list[dict[str, Any]] = []

    async def reserve(_body: dict[str, Any]) -> ReservedBudgetDecision:
        return _reserved()

    async def commit(_reservation: str, body: dict[str, Any]) -> None:
        commits.append(body)

    monkeypatch.setattr(control_client, "reserve_usage", reserve)
    monkeypatch.setattr(control_client, "commit_usage", commit)
    raw = _AsyncStream([_openai_final_chunk()])
    resource = _AsyncCreate(raw)
    stream = await wrap_openai(
        _OpenAIClient(resource), heartbeat_interval_seconds=None
    ).chat.completions.create(**_openai_kwargs(stream=True))
    async with stream:
        seen = [item async for item in stream]
    assert len(seen) == 1
    assert len(commits) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "provider",
    [
        "openai",
        "openai_oversized",
        "openai_total_mismatch",
        "anthropic_cache",
        "anthropic_unknown",
        "anthropic_oversized",
        "anthropic_thinking_overflow",
    ],
)
async def test_async_stream_paid_usage_preserves_terminal_chunk_unresolved(
    monkeypatch: pytest.MonkeyPatch,
    provider: str,
) -> None:
    _init()
    commits: list[object] = []

    async def reserve(_body: dict[str, Any]) -> ReservedBudgetDecision:
        return _reserved()

    async def commit(*args: object) -> None:
        commits.append(args)

    monkeypatch.setattr(control_client, "reserve_usage", reserve)
    monkeypatch.setattr(control_client, "commit_usage", commit)
    if provider.startswith("openai"):
        terminal = _openai_final_chunk()
        if provider == "openai":
            terminal.usage.prompt_tokens_details.audio_tokens = 1
        elif provider == "openai_oversized":
            terminal.usage.completion_tokens_details = _oversized_zero_usage()
        else:
            terminal.usage.total_tokens = 20
        stream = await wrap_openai(
            _OpenAIClient(_AsyncCreate(_AsyncStream([terminal]))),
            heartbeat_interval_seconds=None,
        ).chat.completions.create(**_openai_kwargs(stream=True))
    else:
        terminal = _AnthropicResponse()
        if provider == "anthropic_cache":
            terminal.usage.cache_creation = SimpleNamespace(
                ephemeral_1h_input_tokens=1,
                ephemeral_5m_input_tokens=0,
            )
        elif provider == "anthropic_unknown":
            terminal.usage.unknown_paid_usage = {"premium_units": 1}
        elif provider == "anthropic_oversized":
            terminal.usage.output_tokens_details = _oversized_zero_usage()
        else:
            terminal.usage.output_tokens_details = SimpleNamespace(thinking_tokens=10)
        stream = await wrap_anthropic(
            _AnthropicClient(_AsyncCreate(_AsyncStream([terminal]))),
            heartbeat_interval_seconds=None,
        ).messages.create(**_anthropic_kwargs(stream=True))

    seen = [item async for item in stream]
    assert len(seen) == 1
    assert seen[0] is terminal
    assert commits == []


@pytest.mark.asyncio
async def test_async_stream_early_close_uses_provider_close_and_remains_unresolved(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()
    commits: list[object] = []

    async def reserve(_body: dict[str, Any]) -> ReservedBudgetDecision:
        return _reserved()

    async def commit(*args: object) -> None:
        commits.append(args)

    monkeypatch.setattr(control_client, "reserve_usage", reserve)
    monkeypatch.setattr(control_client, "commit_usage", commit)
    raw = _AsyncStream([_openai_final_chunk()])
    stream = await wrap_openai(
        _OpenAIClient(_AsyncCreate(raw)), heartbeat_interval_seconds=None
    ).chat.completions.create(**_openai_kwargs(stream=True))

    await stream.close()

    assert raw.closed
    assert commits == []


def test_sync_stream_consumer_exception_stops_heartbeat_without_settlement(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()
    starts: list[object] = []
    stops: list[object] = []
    commits: list[object] = []
    releases: list[object] = []
    original_start = controlled_provider._SyncHeartbeat.start
    original_stop = controlled_provider._SyncHeartbeat.stop

    def start(heartbeat: Any) -> None:
        starts.append(heartbeat)
        original_start(heartbeat)

    def stop(heartbeat: Any) -> None:
        stops.append(heartbeat)
        original_stop(heartbeat)

    monkeypatch.setattr(controlled_provider._SyncHeartbeat, "start", start)
    monkeypatch.setattr(controlled_provider._SyncHeartbeat, "stop", stop)
    monkeypatch.setattr(control_client, "reserve_usage_sync", lambda _body: _reserved())
    monkeypatch.setattr(control_client, "commit_usage_sync", lambda *args: commits.append(args))
    monkeypatch.setattr(control_client, "release_usage_sync", lambda *args: releases.append(args))
    raw = _SyncStream([SimpleNamespace(usage=None)])
    stream = wrap_openai(
        _OpenAIClient(_SyncCreate(raw)),
        heartbeat_interval_seconds=1,
    ).chat.completions.create(**_openai_kwargs(stream=True))
    iterator = iter(stream)

    with pytest.raises(RuntimeError, match="consumer processing failed"):
        try:
            next(iterator)
            raise RuntimeError("consumer processing failed")
        finally:
            iterator.close()

    assert starts == stops
    assert len(starts) == 1
    assert raw.closed and raw.close_calls == 1
    assert commits == []
    assert releases == []


@pytest.mark.asyncio
async def test_async_stream_consumer_exception_stops_heartbeat_without_settlement(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()
    starts: list[object] = []
    stops: list[object] = []
    commits: list[object] = []
    releases: list[object] = []
    original_start = controlled_provider._AsyncHeartbeat.start
    original_stop = controlled_provider._AsyncHeartbeat.stop

    def start(heartbeat: Any) -> None:
        starts.append(heartbeat)
        original_start(heartbeat)

    def stop(heartbeat: Any) -> None:
        stops.append(heartbeat)
        original_stop(heartbeat)

    async def reserve(_body: dict[str, Any]) -> ReservedBudgetDecision:
        return _reserved()

    async def commit(*args: object) -> None:
        commits.append(args)

    async def release(*args: object) -> None:
        releases.append(args)

    monkeypatch.setattr(controlled_provider._AsyncHeartbeat, "start", start)
    monkeypatch.setattr(controlled_provider._AsyncHeartbeat, "stop", stop)
    monkeypatch.setattr(control_client, "reserve_usage", reserve)
    monkeypatch.setattr(control_client, "commit_usage", commit)
    monkeypatch.setattr(control_client, "release_usage", release)
    raw = _AsyncStream([SimpleNamespace(usage=None)])
    stream = await wrap_openai(
        _OpenAIClient(_AsyncCreate(raw)),
        heartbeat_interval_seconds=1,
    ).chat.completions.create(**_openai_kwargs(stream=True))
    iterator = stream.__aiter__()

    with pytest.raises(RuntimeError, match="consumer processing failed"):
        try:
            await iterator.__anext__()
            raise RuntimeError("consumer processing failed")
        finally:
            await iterator.aclose()
    await asyncio.sleep(0)

    assert starts == stops
    assert len(starts) == 1
    assert raw.closed and raw.close_calls == 1
    assert commits == []
    assert releases == []


def test_anthropic_native_sync_stream_manager_is_lazy_observed_and_settled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()
    reserve_calls = 0
    commits: list[dict[str, Any]] = []

    def reserve(_body: dict[str, Any]) -> ReservedBudgetDecision:
        nonlocal reserve_calls
        reserve_calls += 1
        return _reserved()

    monkeypatch.setattr(control_client, "reserve_usage_sync", reserve)
    monkeypatch.setattr(
        control_client,
        "commit_usage_sync",
        lambda _reservation, body: commits.append(body),
    )
    resource = _SyncAnthropicNativeResource()
    manager = wrap_anthropic(_AnthropicClient(resource)).messages.stream(**_anthropic_kwargs())
    assert reserve_calls == 0
    assert resource.last_manager is None
    assert resource.stream_calls == []

    with manager as stream:
        assert list(stream.text_stream) == ["hello"]
    assert reserve_calls == 1
    assert "stream" not in resource.stream_calls[0]
    assert len(commits) == 1
    assert resource.last_manager is not None
    assert resource.last_manager.stream.closed
    assert resource.last_manager.stream.close_calls == 1

    # The native final-message helper is also routed through observed
    # iteration instead of bypassing settlement.
    commits.clear()
    manager = wrap_anthropic(_AnthropicClient(resource)).messages.stream(**_anthropic_kwargs())
    with manager as stream:
        assert isinstance(stream.get_final_message(), _AnthropicResponse)
    assert len(commits) == 1


@pytest.mark.asyncio
async def test_anthropic_native_async_stream_manager_preserves_async_with_and_text_stream(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()
    reserve_calls = 0
    commits: list[dict[str, Any]] = []

    async def reserve(_body: dict[str, Any]) -> ReservedBudgetDecision:
        nonlocal reserve_calls
        reserve_calls += 1
        return _reserved()

    async def commit(_reservation: str, body: dict[str, Any]) -> None:
        commits.append(body)

    monkeypatch.setattr(control_client, "reserve_usage", reserve)
    monkeypatch.setattr(control_client, "commit_usage", commit)
    resource = _AsyncAnthropicNativeResource()
    manager = wrap_anthropic(_AnthropicClient(resource)).messages.stream(**_anthropic_kwargs())
    assert reserve_calls == 0

    async with manager as stream:
        text = [item async for item in stream.text_stream]
    assert text == ["hello"]
    assert reserve_calls == 1
    assert len(commits) == 1
    assert resource.last_manager is not None
    assert resource.last_manager.stream.closed
    assert resource.last_manager.stream.close_calls == 1


def test_stream_missing_terminal_usage_returns_chunks_and_remains_unresolved(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()
    commits: list[object] = []
    monkeypatch.setattr(control_client, "reserve_usage_sync", lambda _body: _reserved())
    monkeypatch.setattr(control_client, "commit_usage_sync", lambda *args: commits.append(args))
    raw = _SyncStream([SimpleNamespace(model="gpt-safe", usage=None)])
    stream = wrap_openai(_OpenAIClient(_SyncCreate(raw))).chat.completions.create(
        **_openai_kwargs(stream=True)
    )
    assert len(list(stream)) == 1
    assert commits == []


def test_accessor_only_terminal_evidence_can_settle_once_after_iteration(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()
    commits: list[object] = []
    monkeypatch.setattr(control_client, "reserve_usage_sync", lambda _body: _reserved())
    monkeypatch.setattr(control_client, "commit_usage_sync", lambda *args: commits.append(args))
    stream = wrap_anthropic(
        _AnthropicClient(_SyncCreate(_AccessorOnlySyncStream()))
    ).messages.create(**_anthropic_kwargs(stream=True))

    assert list(stream)
    assert commits == []
    assert isinstance(stream.get_final_message(), _AnthropicResponse)
    assert len(commits) == 1
    assert isinstance(stream.get_final_message(), _AnthropicResponse)
    assert len(commits) == 1


def test_stream_error_and_reinitialization_never_commit_or_release(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()
    commits: list[object] = []
    releases: list[object] = []
    monkeypatch.setattr(control_client, "reserve_usage_sync", lambda _body: _reserved())
    monkeypatch.setattr(control_client, "commit_usage_sync", lambda *args: commits.append(args))
    monkeypatch.setattr(control_client, "release_usage_sync", lambda *args: releases.append(args))

    failing = _SyncStream([SimpleNamespace(usage=None)], fail_after=1)
    stream = wrap_openai(
        _OpenAIClient(_SyncCreate(failing)), heartbeat_interval_seconds=None
    ).chat.completions.create(**_openai_kwargs(stream=True))
    next(stream)
    with pytest.raises(RuntimeError, match="stream failed"):
        next(stream)

    second = _SyncStream([_openai_final_chunk()])
    stream = wrap_openai(
        _OpenAIClient(_SyncCreate(second)), heartbeat_interval_seconds=None
    ).chat.completions.create(**_openai_kwargs(stream=True))
    pylva.init(
        OTHER_KEY,
        endpoint="https://other.invalid",
        local_mode=True,
        control={"mode": "enforce", "on_unavailable": "deny"},
    )
    with pytest.raises(TypeError, match="SDK-owned reserved decision"):
        next(stream)
    assert commits == []
    assert releases == []


def test_long_stream_heartbeat_extends_without_releasing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()
    extended = threading.Event()
    releases: list[object] = []
    monkeypatch.setattr(control_client, "reserve_usage_sync", lambda _body: _reserved())
    monkeypatch.setattr(control_client, "commit_usage_sync", lambda *_args: None)
    monkeypatch.setattr(
        control_client,
        "extend_usage_sync",
        lambda *_args: extended.set(),
    )
    monkeypatch.setattr(control_client, "release_usage_sync", lambda *args: releases.append(args))

    class SlowFirstChunk(_SyncStream):
        def __next__(self) -> object:
            # The heartbeat is active only while provider iteration is
            # blocked. A plain break after this call cannot leak a timer.
            assert extended.wait(1.5)
            return super().__next__()

    raw = SlowFirstChunk([_openai_final_chunk()])
    stream = wrap_openai(
        _OpenAIClient(_SyncCreate(raw)), heartbeat_interval_seconds=1
    ).chat.completions.create(**_openai_kwargs(stream=True))
    list(stream)
    assert extended.is_set()
    assert releases == []


def test_long_nonstream_call_heartbeat_extends_and_stops(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()
    extended = threading.Event()
    extension_count = 0

    def extend(*_args: object) -> None:
        nonlocal extension_count
        extension_count += 1
        extended.set()

    class SlowResource:
        def create(self, **_kwargs: Any) -> _OpenAIResponse:
            assert extended.wait(1.5)
            return _OpenAIResponse()

    monkeypatch.setattr(control_client, "reserve_usage_sync", lambda _body: _reserved())
    monkeypatch.setattr(control_client, "extend_usage_sync", extend)
    monkeypatch.setattr(control_client, "commit_usage_sync", lambda *_args: None)
    result = wrap_openai(
        _OpenAIClient(SlowResource()), heartbeat_interval_seconds=1
    ).chat.completions.create(**_openai_kwargs())
    assert isinstance(result, _OpenAIResponse)
    count_after_return = extension_count
    threading.Event().wait(1.1)
    assert extension_count == count_after_return


def test_sync_heartbeat_stop_waits_for_inflight_extension_and_is_quiescent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()
    extension_started = threading.Event()
    allow_extension_finish = threading.Event()
    extension_finished = threading.Event()
    stop_returned = threading.Event()
    extension_count = 0

    def extend(*_args: object) -> None:
        nonlocal extension_count
        extension_count += 1
        extension_started.set()
        assert allow_extension_finish.wait(2)
        extension_finished.set()

    monkeypatch.setattr(control_client, "extend_usage_sync", extend)
    heartbeat = controlled_provider._SyncHeartbeat(_reserved(), 0.01)
    heartbeat.start()
    assert extension_started.wait(1)

    stopper = threading.Thread(
        target=lambda: (heartbeat.stop(), stop_returned.set()),
    )
    stopper.start()
    assert not stop_returned.wait(0.05)
    allow_extension_finish.set()
    assert stop_returned.wait(1)
    stopper.join(1)

    assert extension_finished.is_set()
    count_after_stop = extension_count
    assert not threading.Event().wait(0.05)
    assert extension_count == count_after_stop == 1


@pytest.mark.asyncio
async def test_async_heartbeat_stop_awaits_cancellation_suppressing_extension(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()
    extension_started = asyncio.Event()
    allow_extension_finish = asyncio.Event()
    extension_finished = asyncio.Event()
    extension_count = 0

    async def extend(*_args: object) -> None:
        nonlocal extension_count
        extension_count += 1
        extension_started.set()
        try:
            await allow_extension_finish.wait()
        except asyncio.CancelledError:
            await allow_extension_finish.wait()
        extension_finished.set()

    monkeypatch.setattr(control_client, "extend_usage", extend)
    heartbeat = controlled_provider._AsyncHeartbeat(_reserved(), 0.01)
    heartbeat.start()
    await asyncio.wait_for(extension_started.wait(), 1)

    heartbeat.stop()
    waiter = asyncio.create_task(heartbeat.wait_stopped())
    await asyncio.sleep(0)
    assert not waiter.done()
    allow_extension_finish.set()
    await asyncio.wait_for(waiter, 1)

    assert extension_finished.is_set()
    count_after_stop = extension_count
    await asyncio.sleep(0.05)
    assert extension_count == count_after_stop == 1


@pytest.mark.asyncio
async def test_async_heartbeat_stop_from_non_loop_thread_is_safe() -> None:
    _init()
    heartbeat = controlled_provider._AsyncHeartbeat(_reserved(), 60)
    heartbeat.start()

    await asyncio.to_thread(heartbeat.stop)
    await heartbeat.wait_stopped()

    assert heartbeat._task is not None  # type: ignore[attr-defined]
    assert heartbeat._task.done()  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_async_heartbeat_wait_preserves_caller_cancellation_on_completion_race() -> None:
    _init()
    finish = asyncio.Event()

    async def heartbeat_task() -> None:
        await finish.wait()

    heartbeat = controlled_provider._AsyncHeartbeat(_reserved(), 60)
    heartbeat._task = asyncio.create_task(heartbeat_task())  # type: ignore[attr-defined]
    waiter = asyncio.create_task(heartbeat.wait_stopped())
    await asyncio.sleep(0)

    finish.set()
    waiter.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiter


@pytest.mark.asyncio
async def test_async_heartbeat_wait_preserves_caller_cancellation_when_inner_is_cancelled() -> None:
    _init()
    heartbeat = controlled_provider._AsyncHeartbeat(_reserved(), 60)
    inner = asyncio.create_task(asyncio.Event().wait())
    heartbeat._task = inner  # type: ignore[attr-defined]
    waiter = asyncio.create_task(heartbeat.wait_stopped())
    await asyncio.sleep(0)

    inner.cancel()
    waiter.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiter


@pytest.mark.asyncio
async def test_async_suppressed_raw_shutdown_preserves_caller_cancellation() -> None:
    close_started = asyncio.Event()
    allow_close = asyncio.Event()
    close_finished = asyncio.Event()

    async def raw_close() -> None:
        close_started.set()
        await allow_close.wait()
        close_finished.set()

    state = SimpleNamespace(
        stream=object(),
        raw_shutdown_lock=threading.Lock(),
        raw_shutdown_task=None,
    )
    caller = asyncio.create_task(
        controlled_provider._async_stream_shutdown_raw(  # type: ignore[arg-type]
            state,
            suppress=True,
            shutdown=raw_close,
        )
    )
    await close_started.wait()

    caller.cancel()
    with pytest.raises(asyncio.CancelledError):
        await caller

    allow_close.set()
    raw_task = state.raw_shutdown_task
    assert isinstance(raw_task, asyncio.Task)
    await raw_task
    assert close_finished.is_set()


@pytest.mark.asyncio
async def test_async_internally_cancelled_raw_shutdown_remains_suppressible() -> None:
    async def raw_close() -> None:
        raise asyncio.CancelledError

    state = SimpleNamespace(
        stream=object(),
        raw_shutdown_lock=threading.Lock(),
        raw_shutdown_task=None,
    )

    result = await controlled_provider._async_stream_shutdown_raw(  # type: ignore[arg-type]
        state,
        suppress=True,
        shutdown=raw_close,
    )

    assert result is None
    raw_task = state.raw_shutdown_task
    assert isinstance(raw_task, asyncio.Task)
    assert raw_task.cancelled()


@pytest.mark.asyncio
async def test_async_raw_shutdown_preserves_caller_cancellation_during_inner_cancellation() -> None:
    close_started = asyncio.Event()

    async def raw_close() -> None:
        close_started.set()
        await asyncio.Event().wait()

    state = SimpleNamespace(
        stream=object(),
        raw_shutdown_lock=threading.Lock(),
        raw_shutdown_task=None,
    )
    caller = asyncio.create_task(
        controlled_provider._async_stream_shutdown_raw(  # type: ignore[arg-type]
            state,
            suppress=True,
            shutdown=raw_close,
        )
    )
    await close_started.wait()
    raw_task = state.raw_shutdown_task
    assert isinstance(raw_task, asyncio.Task)

    raw_task.cancel()
    caller.cancel()
    with pytest.raises(asyncio.CancelledError):
        await caller


def test_lifecycle_finish_and_facade_close_have_no_settlement_eligibility_gap() -> None:
    finish_entered = threading.Event()
    allow_finish = threading.Event()
    close_started = threading.Event()
    close_finished = threading.Event()
    finish_results: list[bool] = []

    class BlockingLease(controlled_provider._ControlledAttemptLifecycleLease):
        __slots__ = ()

        def finish(self) -> bool:
            finish_entered.set()
            assert allow_finish.wait(2)
            return super().finish()

    lifecycle = controlled_provider._ControlledClientLifecycle()
    lease = BlockingLease()
    lifecycle.register_attempt(lease)

    finisher = threading.Thread(
        target=lambda: finish_results.append(lifecycle.finish_attempt(lease))
    )

    def close_facade() -> None:
        close_started.set()
        lifecycle.close()
        close_finished.set()

    closer = threading.Thread(target=close_facade)
    finisher.start()
    assert finish_entered.wait(1)
    closer.start()
    assert close_started.wait(1)
    assert not close_finished.wait(0.1)

    allow_finish.set()
    finisher.join(2)
    closer.join(2)

    assert not finisher.is_alive()
    assert not closer.is_alive()
    assert finish_results == [True]
    assert close_finished.is_set()


def test_sync_facade_close_during_dispatched_nonstream_call_suppresses_settlement(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()
    provider_started = threading.Event()
    provider_release = threading.Event()
    commits: list[object] = []
    releases: list[object] = []
    results: list[object] = []
    errors: list[BaseException] = []
    heartbeat_starts: list[object] = []
    heartbeat_stops: list[object] = []

    original_start = controlled_provider._SyncHeartbeat.start
    original_stop = controlled_provider._SyncHeartbeat.stop

    def record_heartbeat_start(heartbeat: object) -> None:
        heartbeat_starts.append(heartbeat)
        original_start(heartbeat)  # type: ignore[arg-type]

    def record_heartbeat_stop(heartbeat: object) -> None:
        heartbeat_stops.append(heartbeat)
        original_stop(heartbeat)  # type: ignore[arg-type]

    class DelayedResource:
        def create(self, **_kwargs: Any) -> _OpenAIResponse:
            provider_started.set()
            assert provider_release.wait(2)
            return _OpenAIResponse()

    def reserve(body: dict[str, Any]) -> ReservedBudgetDecision:
        return _reserved(operation_id=body["operation_id"])

    monkeypatch.setattr(control_client, "reserve_usage_sync", reserve)
    monkeypatch.setattr(control_client, "commit_usage_sync", lambda *args: commits.append(args))
    monkeypatch.setattr(control_client, "release_usage_sync", lambda *args: releases.append(args))
    monkeypatch.setattr(controlled_provider._SyncHeartbeat, "start", record_heartbeat_start)
    monkeypatch.setattr(controlled_provider._SyncHeartbeat, "stop", record_heartbeat_stop)
    client = wrap_openai(
        _OpenAIClient(DelayedResource()),
        heartbeat_interval_seconds=1,
    )

    def invoke() -> None:
        try:
            results.append(client.chat.completions.create(**_openai_kwargs()))
        except BaseException as error:
            errors.append(error)

    worker = threading.Thread(target=invoke)
    worker.start()
    assert provider_started.wait(1)
    assert len(heartbeat_starts) == 1
    assert heartbeat_starts[0] not in heartbeat_stops
    client.close()
    assert heartbeat_starts[0] in heartbeat_stops
    provider_release.set()
    worker.join(2)

    assert not worker.is_alive()
    assert errors == []
    assert len(results) == 1 and isinstance(results[0], _OpenAIResponse)
    assert commits == []
    assert releases == []


@pytest.mark.asyncio
async def test_async_facade_close_during_dispatched_nonstream_call_suppresses_settlement(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()
    provider_started = asyncio.Event()
    provider_release = asyncio.Event()
    commits: list[object] = []
    releases: list[object] = []
    heartbeat_starts: list[object] = []
    heartbeat_stops: list[object] = []

    original_start = controlled_provider._AsyncHeartbeat.start
    original_stop = controlled_provider._AsyncHeartbeat.stop

    def record_heartbeat_start(heartbeat: object) -> None:
        heartbeat_starts.append(heartbeat)
        original_start(heartbeat)  # type: ignore[arg-type]

    def record_heartbeat_stop(heartbeat: object) -> None:
        heartbeat_stops.append(heartbeat)
        original_stop(heartbeat)  # type: ignore[arg-type]

    class DelayedResource:
        async def create(self, **_kwargs: Any) -> _OpenAIResponse:
            provider_started.set()
            await provider_release.wait()
            return _OpenAIResponse()

    async def reserve(body: dict[str, Any]) -> ReservedBudgetDecision:
        return _reserved(operation_id=body["operation_id"])

    async def commit(*args: object) -> None:
        commits.append(args)

    async def release(*args: object) -> None:
        releases.append(args)

    monkeypatch.setattr(control_client, "reserve_usage", reserve)
    monkeypatch.setattr(control_client, "commit_usage", commit)
    monkeypatch.setattr(control_client, "release_usage", release)
    monkeypatch.setattr(controlled_provider._AsyncHeartbeat, "start", record_heartbeat_start)
    monkeypatch.setattr(controlled_provider._AsyncHeartbeat, "stop", record_heartbeat_stop)
    client = wrap_openai(
        _OpenAIClient(DelayedResource()),
        heartbeat_interval_seconds=1,
    )
    task = asyncio.create_task(client.chat.completions.create(**_openai_kwargs()))
    await provider_started.wait()
    assert len(heartbeat_starts) == 1
    assert heartbeat_starts[0] not in heartbeat_stops
    await client.close()
    assert heartbeat_starts[0] in heartbeat_stops
    provider_release.set()

    result = await task
    assert isinstance(result, _OpenAIResponse)
    assert commits == []
    assert releases == []


def test_stream_break_and_finalizer_stop_lifetime_heartbeat(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()
    stops: list[object] = []
    original_stop = controlled_provider._SyncHeartbeat.stop

    def stop(heartbeat: Any) -> None:
        stops.append(heartbeat)
        original_stop(heartbeat)

    monkeypatch.setattr(controlled_provider._SyncHeartbeat, "stop", stop)
    monkeypatch.setattr(control_client, "reserve_usage_sync", lambda _body: _reserved())
    monkeypatch.setattr(control_client, "commit_usage_sync", lambda *_args: None)
    raw = _SyncStream([SimpleNamespace(usage=None), _openai_final_chunk()])
    stream = wrap_openai(_OpenAIClient(_SyncCreate(raw))).chat.completions.create(
        **_openai_kwargs(stream=True)
    )
    for _chunk in stream:
        break
    assert stops
    assert raw.closed and raw.close_calls == 1

    stops.clear()
    raw = _SyncStream([SimpleNamespace(usage=None)])
    stream = wrap_openai(_OpenAIClient(_SyncCreate(raw))).chat.completions.create(
        **_openai_kwargs(stream=True)
    )
    reference = weakref.ref(stream)
    del stream
    gc.collect()
    assert reference() is None
    assert stops
    assert raw.closed and raw.close_calls == 1


@pytest.mark.asyncio
async def test_async_stream_finalizer_aborts_raw_stream_on_live_loop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()
    commits: list[object] = []
    releases: list[object] = []

    async def reserve(_body: dict[str, Any]) -> ReservedBudgetDecision:
        return _reserved()

    async def commit(*args: object) -> None:
        commits.append(args)

    async def release(*args: object) -> None:
        releases.append(args)

    monkeypatch.setattr(control_client, "reserve_usage", reserve)
    monkeypatch.setattr(control_client, "commit_usage", commit)
    monkeypatch.setattr(control_client, "release_usage", release)
    raw = _AsyncStream([SimpleNamespace(usage=None)])
    stream = await wrap_openai(_OpenAIClient(_AsyncCreate(raw))).chat.completions.create(
        **_openai_kwargs(stream=True)
    )
    reference = weakref.ref(stream)

    del stream
    gc.collect()
    await asyncio.sleep(0)
    await asyncio.sleep(0)

    assert reference() is None
    assert raw.closed and raw.close_calls == 1
    assert commits == []
    assert releases == []


@pytest.mark.asyncio
async def test_async_stream_finalizer_from_non_loop_thread_is_safe(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()

    async def reserve(_body: dict[str, Any]) -> ReservedBudgetDecision:
        return _reserved()

    monkeypatch.setattr(control_client, "reserve_usage", reserve)
    raw = _AsyncStream([SimpleNamespace(usage=None)])
    stream = await wrap_openai(_OpenAIClient(_AsyncCreate(raw))).chat.completions.create(
        **_openai_kwargs(stream=True)
    )
    reference = weakref.ref(stream)
    holder = [stream]
    del stream

    def drop_last_reference() -> None:
        holder.clear()
        gc.collect()

    await asyncio.to_thread(drop_last_reference)
    await asyncio.sleep(0)
    await asyncio.sleep(0)

    assert reference() is None
    assert raw.closed and raw.close_calls == 1


@pytest.mark.asyncio
async def test_async_stream_iterator_close_aborts_raw_once_and_stays_unresolved(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()
    commits: list[object] = []
    releases: list[object] = []

    async def reserve(_body: dict[str, Any]) -> ReservedBudgetDecision:
        return _reserved()

    async def commit(*args: object) -> None:
        commits.append(args)

    async def release(*args: object) -> None:
        releases.append(args)

    monkeypatch.setattr(control_client, "reserve_usage", reserve)
    monkeypatch.setattr(control_client, "commit_usage", commit)
    monkeypatch.setattr(control_client, "release_usage", release)
    raw = _AsyncStream([SimpleNamespace(usage=None), _openai_final_chunk()])
    stream = await wrap_openai(_OpenAIClient(_AsyncCreate(raw))).chat.completions.create(
        **_openai_kwargs(stream=True)
    )
    iterator = stream.__aiter__()
    await iterator.__anext__()
    await iterator.aclose()
    await stream.aclose()

    assert raw.closed and raw.close_calls == 1
    assert commits == []
    assert releases == []


def test_anthropic_sync_break_closes_native_stream_once_without_settlement(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()
    commits: list[object] = []
    releases: list[object] = []
    monkeypatch.setattr(control_client, "reserve_usage_sync", lambda _body: _reserved())
    monkeypatch.setattr(control_client, "commit_usage_sync", lambda *args: commits.append(args))
    monkeypatch.setattr(control_client, "release_usage_sync", lambda *args: releases.append(args))
    resource = _SyncAnthropicNativeResource()

    manager = wrap_anthropic(_AnthropicClient(resource)).messages.stream(**_anthropic_kwargs())
    with manager as stream:
        for _event in stream:
            break

    assert resource.last_manager is not None
    assert resource.last_manager.stream.close_calls == 1
    assert commits == []
    assert releases == []


@pytest.mark.asyncio
async def test_anthropic_async_iterator_close_closes_native_stream_once_unresolved(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()
    commits: list[object] = []
    releases: list[object] = []

    async def reserve(_body: dict[str, Any]) -> ReservedBudgetDecision:
        return _reserved()

    async def commit(*args: object) -> None:
        commits.append(args)

    async def release(*args: object) -> None:
        releases.append(args)

    monkeypatch.setattr(control_client, "reserve_usage", reserve)
    monkeypatch.setattr(control_client, "commit_usage", commit)
    monkeypatch.setattr(control_client, "release_usage", release)
    resource = _AsyncAnthropicNativeResource()
    manager = wrap_anthropic(_AnthropicClient(resource)).messages.stream(**_anthropic_kwargs())

    async with manager as stream:
        iterator = stream.__aiter__()
        await iterator.__anext__()
        await iterator.aclose()

    assert resource.last_manager is not None
    assert resource.last_manager.stream.close_calls == 1
    assert commits == []
    assert releases == []


def test_sync_concurrent_close_runs_raw_shutdown_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()
    close_started = threading.Event()
    allow_close = threading.Event()
    errors: list[BaseException] = []

    class BlockingCloseStream(_SyncStream):
        def close(self) -> None:
            self.close_calls += 1
            close_started.set()
            assert allow_close.wait(2)
            self.closed = True

    monkeypatch.setattr(control_client, "reserve_usage_sync", lambda _body: _reserved())
    raw = BlockingCloseStream([SimpleNamespace(usage=None)])
    stream = wrap_openai(_OpenAIClient(_SyncCreate(raw))).chat.completions.create(
        **_openai_kwargs(stream=True)
    )

    def close() -> None:
        try:
            stream.close()
        except BaseException as error:
            errors.append(error)

    first = threading.Thread(target=close)
    second = threading.Thread(target=close)
    first.start()
    assert close_started.wait(1)
    second.start()
    assert second.is_alive()
    allow_close.set()
    first.join(1)
    second.join(1)

    assert errors == []
    assert raw.closed and raw.close_calls == 1


@pytest.mark.asyncio
async def test_async_concurrent_close_runs_raw_shutdown_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()
    close_started = asyncio.Event()
    allow_close = asyncio.Event()

    class BlockingCloseStream(_AsyncStream):
        async def close(self) -> None:
            self.close_calls += 1
            close_started.set()
            await allow_close.wait()
            self.closed = True

    async def reserve(_body: dict[str, Any]) -> ReservedBudgetDecision:
        return _reserved()

    monkeypatch.setattr(control_client, "reserve_usage", reserve)
    raw = BlockingCloseStream([SimpleNamespace(usage=None)])
    stream = await wrap_openai(_OpenAIClient(_AsyncCreate(raw))).chat.completions.create(
        **_openai_kwargs(stream=True)
    )
    first = asyncio.create_task(stream.close())
    await close_started.wait()
    second = asyncio.create_task(stream.aclose())
    await asyncio.sleep(0)
    assert not second.done()
    allow_close.set()
    await asyncio.gather(first, second)

    assert raw.closed and raw.close_calls == 1


def test_sync_client_close_aborts_active_raw_stream_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()
    commits: list[object] = []
    releases: list[object] = []
    monkeypatch.setattr(control_client, "reserve_usage_sync", lambda _body: _reserved())
    monkeypatch.setattr(control_client, "commit_usage_sync", lambda *args: commits.append(args))
    monkeypatch.setattr(control_client, "release_usage_sync", lambda *args: releases.append(args))
    raw = _SyncStream([SimpleNamespace(usage=None)])
    client = wrap_openai(_OpenAIClient(_SyncCreate(raw)))
    stream = client.chat.completions.create(**_openai_kwargs(stream=True))

    client.close()
    stream.close()

    assert raw.closed and raw.close_calls == 1
    assert commits == []
    assert releases == []


@pytest.mark.asyncio
async def test_async_client_close_aborts_active_raw_stream_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()
    commits: list[object] = []
    releases: list[object] = []

    async def reserve(_body: dict[str, Any]) -> ReservedBudgetDecision:
        return _reserved()

    async def commit(*args: object) -> None:
        commits.append(args)

    async def release(*args: object) -> None:
        releases.append(args)

    monkeypatch.setattr(control_client, "reserve_usage", reserve)
    monkeypatch.setattr(control_client, "commit_usage", commit)
    monkeypatch.setattr(control_client, "release_usage", release)
    raw = _AsyncStream([SimpleNamespace(usage=None)])
    client = wrap_openai(_OpenAIClient(_AsyncCreate(raw)))
    stream = await client.chat.completions.create(**_openai_kwargs(stream=True))

    await client.close()
    await stream.close()

    assert raw.closed and raw.close_calls == 1
    assert commits == []
    assert releases == []


@pytest.mark.asyncio
@pytest.mark.parametrize("provider", ["openai", "anthropic"])
async def test_async_client_close_survives_caller_cancellation_and_retry(
    provider: str,
) -> None:
    _init()
    private_close_started = asyncio.Event()
    allow_private_close = asyncio.Event()
    private_close_calls = 0

    async def private_close() -> None:
        nonlocal private_close_calls
        private_close_calls += 1
        private_close_started.set()
        await allow_private_close.wait()

    if provider == "openai":
        openai_native = _OpenAIClient(_AsyncCreate(_OpenAIResponse()))
        openai_native.close = private_close  # type: ignore[attr-defined]
        client = wrap_openai(openai_native)
    else:
        anthropic_native = _AnthropicClient(_AsyncCreate(_AnthropicResponse()))
        anthropic_native.close = private_close  # type: ignore[attr-defined]
        client = wrap_anthropic(anthropic_native)

    first = asyncio.create_task(client.close())
    await private_close_started.wait()
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first

    retry = asyncio.create_task(client.close())
    await asyncio.sleep(0)
    assert not retry.done()
    assert private_close_calls == 1
    allow_private_close.set()
    await retry

    assert private_close_calls == 1


@pytest.mark.parametrize("provider", ["openai", "anthropic"])
def test_async_client_rejects_cross_loop_close_without_duplicate_shutdown(
    provider: str,
) -> None:
    _init()
    start = threading.Barrier(2)
    private_close_calls = 0
    successes: list[None] = []
    errors: list[BaseException] = []

    async def private_close() -> None:
        nonlocal private_close_calls
        private_close_calls += 1
        await asyncio.sleep(0.02)

    if provider == "openai":
        openai_native = _OpenAIClient(_AsyncCreate(_OpenAIResponse()))
        openai_native.close = private_close  # type: ignore[attr-defined]
        client = wrap_openai(openai_native)
    else:
        anthropic_native = _AnthropicClient(_AsyncCreate(_AnthropicResponse()))
        anthropic_native.close = private_close  # type: ignore[attr-defined]
        client = wrap_anthropic(anthropic_native)

    def close() -> None:
        start.wait()
        try:
            asyncio.run(client.close())
            successes.append(None)
        except BaseException as error:
            errors.append(error)

    first = threading.Thread(target=close)
    second = threading.Thread(target=close)
    first.start()
    second.start()
    first.join(2)
    second.join(2)

    assert not first.is_alive()
    assert not second.is_alive()
    assert successes == [None]
    assert len(errors) == 1
    assert isinstance(errors[0], PylvaStrictProviderError)
    assert errors[0].reason == "invalid_client"
    assert private_close_calls == 1


@pytest.mark.parametrize("provider", ["openai", "anthropic"])
def test_async_client_loop_teardown_refuses_cross_loop_close_retry(
    provider: str,
) -> None:
    _init()
    private_close_started = threading.Event()
    private_close_cancelled = threading.Event()
    private_close_calls = 0

    async def private_close() -> None:
        nonlocal private_close_calls
        private_close_calls += 1
        private_close_started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            private_close_cancelled.set()
            raise

    if provider == "openai":
        openai_native = _OpenAIClient(_AsyncCreate(_OpenAIResponse()))
        openai_native.close = private_close  # type: ignore[attr-defined]
        client = wrap_openai(openai_native)
    else:
        anthropic_native = _AnthropicClient(_AsyncCreate(_AnthropicResponse()))
        anthropic_native.close = private_close  # type: ignore[attr-defined]
        client = wrap_anthropic(anthropic_native)

    async def time_out_close() -> None:
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(client.close(), timeout=0.01)

    asyncio.run(time_out_close())
    assert private_close_started.is_set()
    assert private_close_cancelled.is_set()

    with pytest.raises(PylvaStrictProviderError) as raised:
        asyncio.run(client.close())

    assert raised.value.reason == "invalid_client"
    assert private_close_calls == 1


@pytest.mark.parametrize("provider", ["openai", "anthropic"])
def test_async_provider_operation_binds_facade_to_first_event_loop(
    monkeypatch: pytest.MonkeyPatch,
    provider: str,
) -> None:
    _init()
    reservations = 0

    async def reserve(body: dict[str, Any]) -> BypassedBudgetDecision:
        nonlocal reservations
        reservations += 1
        return _bypassed()

    monkeypatch.setattr(control_client, "reserve_usage", reserve)
    if provider == "openai":
        create = _AsyncCreate(_OpenAIResponse())
        client = wrap_openai(_OpenAIClient(create))

        async def invoke() -> None:
            await client.chat.completions.create(**_openai_kwargs())

    else:
        create = _AsyncCreate(_AnthropicResponse())
        client = wrap_anthropic(_AnthropicClient(create))

        async def invoke() -> None:
            await client.messages.create(**_anthropic_kwargs())

    asyncio.run(invoke())
    with pytest.raises(PylvaStrictProviderError) as raised:
        asyncio.run(invoke())

    assert raised.value.reason == "invalid_client"
    assert reservations == 1
    assert len(create.calls) == 1


@pytest.mark.parametrize("provider", ["openai", "anthropic"])
def test_sync_client_concurrent_close_waits_for_private_shutdown_once(
    provider: str,
) -> None:
    _init()
    private_close_started = threading.Event()
    allow_private_close = threading.Event()
    private_close_calls = 0
    errors: list[BaseException] = []

    def private_close() -> None:
        nonlocal private_close_calls
        private_close_calls += 1
        private_close_started.set()
        assert allow_private_close.wait(2)

    if provider == "openai":
        openai_native = _OpenAIClient(_SyncCreate(_OpenAIResponse()))
        openai_native.close = private_close  # type: ignore[attr-defined]
        client = wrap_openai(openai_native)
    else:
        anthropic_native = _AnthropicClient(_SyncCreate(_AnthropicResponse()))
        anthropic_native.close = private_close  # type: ignore[attr-defined]
        client = wrap_anthropic(anthropic_native)

    def close() -> None:
        try:
            client.close()
        except BaseException as error:
            errors.append(error)

    first = threading.Thread(target=close)
    second = threading.Thread(target=close)
    first.start()
    assert private_close_started.wait(1)
    second.start()
    assert second.is_alive()
    assert private_close_calls == 1
    allow_private_close.set()
    first.join(1)
    second.join(1)

    assert not first.is_alive()
    assert not second.is_alive()
    assert errors == []
    assert private_close_calls == 1


@pytest.mark.parametrize("provider", ["openai", "anthropic"])
def test_sync_client_close_replays_private_shutdown_error(provider: str) -> None:
    _init()
    private_close_calls = 0

    def private_close() -> None:
        nonlocal private_close_calls
        private_close_calls += 1
        raise RuntimeError("private close failed")

    if provider == "openai":
        openai_native = _OpenAIClient(_SyncCreate(_OpenAIResponse()))
        openai_native.close = private_close  # type: ignore[attr-defined]
        client = wrap_openai(openai_native)
    else:
        anthropic_native = _AnthropicClient(_SyncCreate(_AnthropicResponse()))
        anthropic_native.close = private_close  # type: ignore[attr-defined]
        client = wrap_anthropic(anthropic_native)

    with pytest.raises(RuntimeError, match="private close failed"):
        client.close()
    with pytest.raises(RuntimeError, match="private close failed"):
        client.close()

    assert private_close_calls == 1


def test_sync_implicit_cleanup_preserves_consumer_error_and_replays_close_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()

    class FailingCloseStream(_SyncStream):
        def close(self) -> None:
            self.close_calls += 1
            raise RuntimeError("raw close failed")

    monkeypatch.setattr(control_client, "reserve_usage_sync", lambda _body: _reserved())
    raw = FailingCloseStream([SimpleNamespace(usage=None)])
    stream = wrap_openai(_OpenAIClient(_SyncCreate(raw))).chat.completions.create(
        **_openai_kwargs(stream=True)
    )
    iterator = iter(stream)

    with pytest.raises(RuntimeError, match="consumer failed"):
        try:
            next(iterator)
            raise RuntimeError("consumer failed")
        finally:
            iterator.close()
    with pytest.raises(RuntimeError, match="raw close failed"):
        stream.close()
    assert raw.close_calls == 1


@pytest.mark.asyncio
async def test_async_implicit_cleanup_preserves_consumer_error_and_replays_close_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()

    class FailingCloseStream(_AsyncStream):
        async def close(self) -> None:
            self.close_calls += 1
            raise RuntimeError("raw close failed")

    async def reserve(_body: dict[str, Any]) -> ReservedBudgetDecision:
        return _reserved()

    monkeypatch.setattr(control_client, "reserve_usage", reserve)
    raw = FailingCloseStream([SimpleNamespace(usage=None)])
    stream = await wrap_openai(_OpenAIClient(_AsyncCreate(raw))).chat.completions.create(
        **_openai_kwargs(stream=True)
    )
    iterator = stream.__aiter__()

    with pytest.raises(RuntimeError, match="consumer failed"):
        try:
            await iterator.__anext__()
            raise RuntimeError("consumer failed")
        finally:
            await iterator.aclose()
    with pytest.raises(RuntimeError, match="raw close failed"):
        await stream.close()
    assert raw.close_calls == 1


@pytest.mark.asyncio
async def test_async_stream_failure_starts_raw_shutdown_before_cleanup_cancellation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()
    heartbeat_wait_started = asyncio.Event()
    close_started = asyncio.Event()
    allow_close = asyncio.Event()
    close_finished = asyncio.Event()

    class FailingNextStream(_AsyncStream):
        async def __anext__(self) -> object:
            raise RuntimeError("stream failed")

        async def close(self) -> None:
            self.close_calls += 1
            close_started.set()
            await allow_close.wait()
            self.closed = True
            close_finished.set()

    async def reserve(_body: dict[str, Any]) -> ReservedBudgetDecision:
        return _reserved()

    async def blocking_wait_stopped(_heartbeat: object) -> None:
        heartbeat_wait_started.set()
        await asyncio.Event().wait()

    monkeypatch.setattr(control_client, "reserve_usage", reserve)
    monkeypatch.setattr(
        controlled_provider._AsyncHeartbeat,
        "wait_stopped",
        blocking_wait_stopped,
    )
    raw = FailingNextStream([])
    stream = await wrap_openai(
        _OpenAIClient(_AsyncCreate(raw)),
        heartbeat_interval_seconds=None,
    ).chat.completions.create(**_openai_kwargs(stream=True))
    stream_ref = weakref.ref(stream)

    consumer = asyncio.create_task(stream.__anext__())
    await heartbeat_wait_started.wait()
    await close_started.wait()
    consumer.cancel()
    with pytest.raises(asyncio.CancelledError):
        await consumer

    allow_close.set()
    await close_finished.wait()
    del consumer
    del stream
    gc.collect()
    await asyncio.sleep(0)

    assert stream_ref() is None
    assert raw.closed
    assert raw.close_calls == 1


@pytest.mark.parametrize("interval", [0, 0.99, 100.01, 300, float("inf")])
def test_heartbeat_interval_must_be_within_safe_ttl_fraction(interval: float) -> None:
    _init(mode="legacy", on_unavailable="allow")
    with pytest.raises(PylvaStrictProviderError):
        wrap_openai(
            _OpenAIClient(_SyncCreate(_OpenAIResponse())), heartbeat_interval_seconds=interval
        )


def test_nested_controlled_calls_keep_independent_reservation_ownership(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()
    commits: list[str] = []
    reservation_counter = 0

    def reserve(_body: dict[str, Any]) -> ReservedBudgetDecision:
        nonlocal reservation_counter
        reservation_counter += 1
        return _reserved()

    monkeypatch.setattr(control_client, "reserve_usage_sync", reserve)
    monkeypatch.setattr(
        control_client,
        "commit_usage_sync",
        lambda reservation, _body: commits.append(reservation),
    )
    inner_resource = _SyncCreate(_AnthropicResponse())
    inner = wrap_anthropic(_AnthropicClient(inner_resource))

    class OuterResource:
        def create(self, **_kwargs: Any) -> _OpenAIResponse:
            inner.messages.create(**_anthropic_kwargs())
            return _OpenAIResponse()

    outer = wrap_openai(_OpenAIClient(OuterResource()))
    outer.chat.completions.create(**_openai_kwargs())

    assert reservation_counter == 2
    assert len(commits) == 2
    assert telemetry.buffer_size() == 0


def test_provider_attempt_exposes_exact_operation_reservation_and_trace(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()
    reservation_body: dict[str, Any] = {}
    seen: list[tuple[str, str, str, str]] = []
    attempt_seen: list[tuple[str, str | None, str, str, bool, bool]] = []

    def reserve(body: dict[str, Any]) -> ReservedBudgetDecision:
        reservation_body.update(body)
        return _reserved(body["trace_id"], body["span_id"], body["operation_id"])

    class Resource:
        def create(self, **_kwargs: Any) -> _OpenAIResponse:
            ownership = current_controlled_operation()
            assert ownership is not None
            seen.append(
                (
                    ownership.operation_id,
                    ownership.reservation_id,
                    ownership.trace_id,
                    ownership.span_id,
                )
            )
            attempt = current_controlled_attempt()
            assert attempt is not None
            attempt_seen.append(
                (
                    attempt.operation_id,
                    attempt.reservation_id,
                    attempt.trace_id,
                    attempt.span_id,
                    attempt.owns_reservation,
                    attempt.legacy_telemetry_required,
                )
            )
            return _OpenAIResponse()

    monkeypatch.setattr(control_client, "reserve_usage_sync", reserve)
    monkeypatch.setattr(control_client, "commit_usage_sync", lambda *_args: None)
    wrap_openai(_OpenAIClient(Resource())).chat.completions.create(**_openai_kwargs())

    assert seen == [
        (
            reservation_body["operation_id"],
            "33333333-3333-4333-8333-333333333333",
            reservation_body["trace_id"],
            reservation_body["span_id"],
        )
    ]
    assert attempt_seen == [
        (
            reservation_body["operation_id"],
            "33333333-3333-4333-8333-333333333333",
            reservation_body["trace_id"],
            reservation_body["span_id"],
            True,
            False,
        )
    ]


def test_rollout_attempt_context_marks_bypass_for_callback_deduplication(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init(mode="shadow", on_unavailable="allow")
    seen: list[tuple[bool, bool, str | None]] = []

    class Resource:
        def create(self, **_kwargs: Any) -> _OpenAIResponse:
            attempt = current_controlled_attempt()
            assert attempt is not None
            seen.append(
                (
                    attempt.owns_reservation,
                    attempt.legacy_telemetry_required,
                    attempt.reservation_id,
                )
            )
            assert current_controlled_operation() is None
            return _OpenAIResponse()

    monkeypatch.setattr(
        control_client,
        "reserve_usage_sync",
        lambda _body: _bypassed("shadow_would_allow"),
    )
    wrap_openai(_OpenAIClient(Resource())).chat.completions.create(**_openai_kwargs())

    assert seen == [(False, True, None)]
    assert telemetry.buffer_size() == 1


def test_proven_local_predispatch_failure_releases_but_invoked_error_does_not(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()
    releases: list[dict[str, Any]] = []
    resource = _SyncCreate(_OpenAIResponse())
    monkeypatch.setattr(control_client, "reserve_usage_sync", lambda _body: _reserved())
    monkeypatch.setattr(
        control_client,
        "release_usage_sync",
        lambda _reservation, body: releases.append(body),
    )

    @contextmanager
    def fail_before_dispatch(*_args: object) -> Iterator[None]:
        raise RuntimeError("local context failure")
        yield

    monkeypatch.setattr(controlled_provider, "dispatch_context", fail_before_dispatch)
    with pytest.raises(RuntimeError, match="local context failure"):
        wrap_openai(_OpenAIClient(resource)).chat.completions.create(**_openai_kwargs())
    assert resource.calls == []
    assert releases == [{"reason": "provider_not_called"}]

    monkeypatch.undo()
    _init()
    releases.clear()
    invoked = _SyncCreate(_OpenAIResponse(), error=RuntimeError("ambiguous provider error"))
    monkeypatch.setattr(control_client, "reserve_usage_sync", lambda _body: _reserved())
    monkeypatch.setattr(
        control_client,
        "release_usage_sync",
        lambda _reservation, body: releases.append(body),
    )
    with pytest.raises(RuntimeError, match="ambiguous provider error"):
        wrap_openai(_OpenAIClient(invoked)).chat.completions.create(**_openai_kwargs())
    assert len(invoked.calls) == 1
    assert releases == []


class _HostileMapping(Mapping[str, Any]):
    def __getitem__(self, key: str) -> Any:
        raise AssertionError(key)

    def __iter__(self) -> Iterator[str]:
        raise AssertionError("custom mapping must not be traversed")

    def __len__(self) -> int:
        raise AssertionError("custom mapping must not be traversed")


class _HostileString(str):
    def encode(self, *_args: object, **_kwargs: object) -> bytes:
        raise AssertionError("custom scalar methods must not be called")


def test_top_level_custom_mapping_and_shared_aliases_are_rejected_without_traversal() -> None:
    hostile = _HostileMapping()
    with pytest.raises(PylvaStrictProviderError) as openai_error:
        controlled_provider.prepare_openai_request(hostile)
    with pytest.raises(PylvaStrictProviderError) as anthropic_error:
        controlled_provider.prepare_anthropic_request(hostile)
    assert openai_error.value.reason == anthropic_error.value.reason == "unsupported_request_shape"

    openai_shared = {"type": "text", "text": "shared"}
    with pytest.raises(PylvaStrictProviderError) as openai_alias_error:
        controlled_provider.prepare_openai_request(
            _openai_kwargs(
                messages=[
                    {
                        "role": "user",
                        "content": [openai_shared, openai_shared],
                    }
                ]
            )
        )
    anthropic_shared = {"type": "text", "text": "shared"}
    with pytest.raises(PylvaStrictProviderError) as anthropic_alias_error:
        controlled_provider.prepare_anthropic_request(
            _anthropic_kwargs(
                messages=[
                    {
                        "role": "user",
                        "content": [anthropic_shared, anthropic_shared],
                    }
                ]
            )
        )
    assert (
        openai_alias_error.value.reason
        == anthropic_alias_error.value.reason
        == "unsupported_request_shape"
    )


def test_local_bound_rejects_cycles_depth_custom_mappings_and_huge_values_content_free(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()
    resource = _SyncCreate(_OpenAIResponse())
    reserve_calls = 0

    def reserve(_body: dict[str, Any]) -> object:
        nonlocal reserve_calls
        reserve_calls += 1
        return _reserved()

    monkeypatch.setattr(control_client, "reserve_usage_sync", reserve)
    cyclic: dict[str, Any] = {"role": "user"}
    cyclic["content"] = [cyclic]
    deep: dict[str, Any] = {"type": "string"}
    for _ in range(30):
        deep = {"properties": {"x": deep}}
    secret = "PRIVATE-BOUNDARY-SECRET"
    requests = [
        _openai_kwargs(messages=[cyclic]),
        _openai_kwargs(
            tools=[
                {
                    "type": "function",
                    "function": {"name": "f", "parameters": deep},
                }
            ]
        ),
        _openai_kwargs(response_format=_HostileMapping()),
        _openai_kwargs(messages=[{"role": "user", "content": _HostileString(secret)}]),
        _openai_kwargs(messages=[{"role": "user", "content": secret * 200_000}]),
    ]
    for request in requests:
        with pytest.raises(PylvaStrictProviderError) as caught:
            wrap_openai(_OpenAIClient(resource)).chat.completions.create(**request)
        assert secret not in str(caught.value)
    assert reserve_calls == 0
    assert resource.calls == []
