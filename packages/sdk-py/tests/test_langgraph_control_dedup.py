"""Exact LangGraph callback ownership and de-duplication tests."""

from __future__ import annotations

import asyncio
import uuid
import warnings
from types import SimpleNamespace
from typing import Any

import pytest

import pylva
from pylva.adapters.tavily import controlled_tavily_search, controlled_tavily_search_sync
from pylva.core import control_client, telemetry
from pylva.core import controlled_usage as controlled_usage_subject
from pylva.core.config import get_config, get_config_generation
from pylva.core.control_ownership import (
    ControlledAttemptContext,
    _controlled_attempt_scope,
    _register_controlled_reservation,
)
from pylva.core.control_schema import ReservedBudgetDecision
from pylva.errors.budget_exceeded import BudgetExceededSource, PylvaBudgetExceeded
from pylva.errors.control import PylvaControlValidationError
from pylva.errors.strict_provider import PylvaStrictProviderError
from pylva.langchain import (
    AsyncPylvaCallbackHandler,
    PylvaCallbackHandler,
    langgraph_control_scope,
)
from pylva.wrappers import _controlled_provider as controlled_provider
from pylva.wrappers.anthropic_controlled import _wrap_anthropic_for_tests as wrap_anthropic
from pylva.wrappers.openai_controlled import _wrap_openai_for_tests as wrap_openai

KEY_A = "pv_live_aabbccdd_" + "a" * 32
KEY_B = "pv_live_bbccddee_" + "b" * 32


class _Response:
    def __init__(self) -> None:
        self.generations: list[Any] = []
        self.llm_output = {
            "token_usage": {"prompt_tokens": 4, "completion_tokens": 2},
            "provider": "openai",
            "model": "gpt-4o-mini",
        }


def setup_function(_fn: object) -> None:
    telemetry._reset_telemetry_for_tests()  # type: ignore[attr-defined]


def _llm_attempt(
    *,
    owns_reservation: bool = True,
    legacy_telemetry_required: bool = False,
) -> ControlledAttemptContext:
    return ControlledAttemptContext(
        kind="llm",
        operation_id=str(uuid.uuid4()),
        reservation_id=str(uuid.uuid4()) if owns_reservation else None,
        trace_id=str(uuid.uuid4()),
        span_id=str(uuid.uuid4()),
        parent_span_id=None,
        customer_id="customer_acme",
        provider="openai",
        model="gpt-4o-mini",
        owns_reservation=owns_reservation,
        legacy_telemetry_required=legacy_telemetry_required,
        config_generation=get_config_generation(),
    )


def _tool_attempt() -> ControlledAttemptContext:
    return ControlledAttemptContext(
        kind="tool",
        operation_id=str(uuid.uuid4()),
        reservation_id=str(uuid.uuid4()),
        trace_id=str(uuid.uuid4()),
        span_id=str(uuid.uuid4()),
        parent_span_id=None,
        customer_id="customer_acme",
        cost_source_slug="tavily-search",
        tool_name="tavily_search",
        metric="searches",
        owns_reservation=True,
        legacy_telemetry_required=False,
        config_generation=get_config_generation(),
    )


def _start_llm(handler: PylvaCallbackHandler, run_id: uuid.UUID) -> None:
    handler.on_chat_model_start(
        {"name": "ChatOpenAI"},
        [[object()]],
        run_id=run_id,
        metadata={
            "pylva_customer_id": "customer_acme",
            "langgraph_node": "call_model",
            "ls_provider": "openai",
            "ls_model_name": "gpt-4o-mini",
        },
    )


def _end_llm(handler: PylvaCallbackHandler, run_id: uuid.UUID) -> None:
    handler.on_llm_end(_Response(), run_id=run_id)


def _authoritative_denial() -> PylvaBudgetExceeded:
    return PylvaBudgetExceeded(
        source=BudgetExceededSource.AUTHORITATIVE_CONTROL,
        rule_id="rule-denied",
        customer_id="customer_acme",
        period="day",
        period_start="2026-07-14T00:00:00.000Z",
        limit_usd=1.0,
        accumulated_usd=1.0,
        estimated_usd=0.1,
    )


def _reserved_decision(request: dict[str, Any]) -> ReservedBudgetDecision:
    decision = ReservedBudgetDecision.model_validate(
        {
            "schema_version": "1.0",
            "decision": "reserved",
            "allowed": True,
            "decision_id": str(uuid.uuid4()),
            "operation_id": request["operation_id"],
            "reservation_id": str(uuid.uuid4()),
            "state": "reserved",
            "reserved_usd": "1",
            "remaining_usd": "2",
            "expires_at": "2026-07-14T10:00:00.000Z",
            "warnings": [],
        },
        strict=True,
    )
    config = get_config()
    assert config is not None
    assert _register_controlled_reservation(
        decision,
        config,
        get_config_generation(),
        request["trace_id"],
        request["span_id"],
    )
    return decision


def _exact_openai_stream_event() -> dict[str, object]:
    return {
        "model": "gpt-4o-mini",
        "service_tier": "default",
        "usage": {
            "prompt_tokens": 4,
            "completion_tokens": 2,
            "total_tokens": 6,
            "prompt_tokens_details": {
                "cached_tokens": 0,
                "cache_write_tokens": 0,
            },
        },
    }


class _DeniedSyncCompletions:
    def __init__(self) -> None:
        self.calls = 0

    def create(self, **_kwargs: Any) -> object:
        self.calls += 1
        return object()


class _DeniedAsyncCompletions(_DeniedSyncCompletions):
    async def create(self, **_kwargs: Any) -> object:
        self.calls += 1
        return object()


class _DeniedOpenAIClient:
    def __init__(self, completions: object) -> None:
        self.max_retries = 0
        self.chat = SimpleNamespace(completions=completions)


class _DeniedAnthropicClient:
    def __init__(self, messages: object) -> None:
        self.max_retries = 0
        self.messages = messages


class _DeniedSyncTavilyClient:
    def __init__(self) -> None:
        self.calls = 0

    def search(self, _query: str, **_options: Any) -> object:
        self.calls += 1
        return {"usage": {"credits": 1}}


class _DeniedAsyncTavilyClient(_DeniedSyncTavilyClient):
    async def search(self, _query: str, **_options: Any) -> object:
        self.calls += 1
        return {"usage": {"credits": 1}}


class _ExactSyncStream:
    def __init__(self) -> None:
        self._events = iter([_exact_openai_stream_event()])
        self.close_calls = 0

    def __iter__(self) -> _ExactSyncStream:
        return self

    def __next__(self) -> object:
        return next(self._events)

    def close(self) -> None:
        self.close_calls += 1


class _ExactAsyncStream:
    def __init__(self) -> None:
        self._events = iter([_exact_openai_stream_event()])
        self.close_calls = 0

    def __aiter__(self) -> _ExactAsyncStream:
        return self

    async def __anext__(self) -> object:
        try:
            return next(self._events)
        except StopIteration as error:
            raise StopAsyncIteration from error

    async def close(self) -> None:
        self.close_calls += 1


class _SyncStreamingCompletions:
    def __init__(self) -> None:
        self.calls = 0
        self.streams: list[_ExactSyncStream] = []

    def create(self, **kwargs: Any) -> _ExactSyncStream:
        assert kwargs["stream"] is True
        self.calls += 1
        stream = _ExactSyncStream()
        self.streams.append(stream)
        return stream


class _AsyncStreamingCompletions:
    def __init__(self) -> None:
        self.calls = 0
        self.streams: list[_ExactAsyncStream] = []

    async def create(self, **kwargs: Any) -> _ExactAsyncStream:
        assert kwargs["stream"] is True
        self.calls += 1
        stream = _ExactAsyncStream()
        self.streams.append(stream)
        return stream


def test_auto_suppresses_reserved_wrapper_callback_after_dispatch_scope_exits() -> None:
    handler = PylvaCallbackHandler()
    run_id = uuid.uuid4()

    with _controlled_attempt_scope(_llm_attempt()):
        _start_llm(handler, run_id)
    _end_llm(handler, run_id)
    handler.on_llm_error(RuntimeError("late duplicate"), run_id=run_id)

    assert telemetry.buffer_size() == 0


@pytest.mark.parametrize("decision", ["bypassed", "unavailable"])
def test_auto_suppresses_callback_when_wrapper_owns_legacy_fallback(decision: str) -> None:
    handler = PylvaCallbackHandler()
    run_id = uuid.uuid4()

    with _controlled_attempt_scope(
        _llm_attempt(owns_reservation=False, legacy_telemetry_required=True)
    ):
        _start_llm(handler, run_id)
    _end_llm(handler, run_id)

    assert decision in {"bypassed", "unavailable"}
    assert telemetry.buffer_size() == 0


def test_callback_mode_is_explicit_callback_only_and_invalid_values_fail() -> None:
    handler = PylvaCallbackHandler(llm_tracking="callback")
    run_id = uuid.uuid4()

    with _controlled_attempt_scope(_llm_attempt()):
        _start_llm(handler, run_id)
    _end_llm(handler, run_id)

    assert telemetry.buffer_size() == 1
    with pytest.raises(TypeError, match="llm_tracking must be"):
        PylvaCallbackHandler(llm_tracking="invalid")  # type: ignore[arg-type]


def test_off_mode_ignores_llm_callbacks() -> None:
    handler = PylvaCallbackHandler(llm_tracking="off")
    run_id = uuid.uuid4()
    assert handler.ignore_llm is True

    _start_llm(handler, run_id)
    _end_llm(handler, run_id)
    handler.on_llm_error(RuntimeError("ignored"), run_id=run_id)

    assert telemetry.buffer_size() == 0


def test_only_same_kind_controlled_tool_callback_is_suppressed() -> None:
    handler = PylvaCallbackHandler(track_tool_calls=True)
    owned = uuid.uuid4()
    unrelated = uuid.uuid4()

    with _controlled_attempt_scope(_tool_attempt()):
        handler.on_tool_start(
            {"name": "tavily_search"},
            "PRIVATE QUERY",
            run_id=owned,
            metadata={"langgraph_node": "search"},
        )
    handler.on_tool_end("PRIVATE RESULT", run_id=owned)

    with _controlled_attempt_scope(_llm_attempt()):
        handler.on_tool_start(
            {"name": "tavily_search"},
            "PRIVATE QUERY",
            run_id=unrelated,
            metadata={"langgraph_node": "search"},
        )
    handler.on_tool_end("PRIVATE RESULT", run_id=unrelated)

    assert telemetry.buffer_size() == 1
    event = telemetry._state.buffer[0]  # type: ignore[attr-defined]
    assert event["tool_name"] == "tavily_search"


@pytest.mark.asyncio
async def test_nested_and_concurrent_identical_model_attempts_remain_isolated() -> None:
    handler = AsyncPylvaCallbackHandler()
    run_ids = [uuid.uuid4() for _ in range(4)]

    with _controlled_attempt_scope(_llm_attempt()):
        await handler.on_chat_model_start({"name": "ChatOpenAI"}, [[object()]], run_id=run_ids[0])
        with _controlled_attempt_scope(_llm_attempt()):
            await handler.on_chat_model_start(
                {"name": "ChatOpenAI"}, [[object()]], run_id=run_ids[1]
            )

    async def start(run_id: uuid.UUID) -> None:
        with _controlled_attempt_scope(_llm_attempt()):
            await handler.on_chat_model_start({"name": "ChatOpenAI"}, [[object()]], run_id=run_id)
            await asyncio.sleep(0)

    await asyncio.gather(start(run_ids[2]), start(run_ids[3]))
    for run_id in run_ids:
        await handler.on_llm_end(_Response(), run_id=run_id)

    assert telemetry.buffer_size() == 0


def test_reinit_drops_old_identity_terminal_callback_and_duplicate() -> None:
    handler = PylvaCallbackHandler(
        api_key=KEY_A,
        endpoint="https://same.test",
        local_mode=True,
        flush_on_chain_end=True,
    )
    root_run_id = uuid.uuid4()
    llm_run_id = uuid.uuid4()
    handler.on_chain_start({"name": "graph"}, {}, run_id=root_run_id)
    with _controlled_attempt_scope(_llm_attempt()):
        _start_llm(handler, llm_run_id)

    PylvaCallbackHandler(
        api_key=KEY_B,
        endpoint="https://same.test",
        local_mode=True,
    )
    _end_llm(handler, llm_run_id)
    _end_llm(handler, llm_run_id)
    handler.on_chain_end({}, run_id=root_run_id)
    handler.on_chain_end({}, run_id=root_run_id)

    assert telemetry.buffer_size() == 0


def test_control_config_is_forwarded_by_callback_initialization() -> None:
    handler = PylvaCallbackHandler(
        api_key=KEY_A,
        local_mode=True,
        control={"mode": "enforce", "on_unavailable": "deny", "timeout_ms": 1_500},
    )
    assert handler.llm_tracking == "auto"
    config = get_config()
    assert config is not None
    assert config.control.mode == "enforce"
    assert config.control.on_unavailable == "deny"
    assert config.control.timeout_ms == 1_500


def test_public_scope_links_callback_first_provider_second() -> None:
    handler = PylvaCallbackHandler()
    run_id = uuid.uuid4()

    with langgraph_control_scope():
        _start_llm(handler, run_id)
        with _controlled_attempt_scope(_llm_attempt()):
            pass
    _end_llm(handler, run_id)

    assert telemetry.buffer_size() == 0


def test_sync_streaming_wrapper_settles_once_and_suppresses_duplicate_callback_telemetry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    handler = PylvaCallbackHandler(
        api_key=KEY_A,
        endpoint="https://unit.invalid",
        local_mode=True,
        control={"mode": "enforce", "on_unavailable": "deny"},
    )
    run_id = uuid.uuid4()
    resource = _SyncStreamingCompletions()
    reserves: list[dict[str, Any]] = []
    commits: list[tuple[str, dict[str, Any]]] = []
    releases: list[object] = []

    def reserve(request: dict[str, Any]) -> ReservedBudgetDecision:
        reserves.append(request)
        return _reserved_decision(request)

    monkeypatch.setattr(control_client, "reserve_usage_sync", reserve)
    monkeypatch.setattr(
        control_client,
        "commit_usage_sync",
        lambda reservation_id, request: commits.append((reservation_id, request)),
    )
    monkeypatch.setattr(
        control_client,
        "release_usage_sync",
        lambda *_args: releases.append(_args),
    )
    client = wrap_openai(_DeniedOpenAIClient(resource))

    with warnings.catch_warnings(record=True) as emitted:
        warnings.simplefilter("always")
        with langgraph_control_scope():
            _start_llm(handler, run_id)
            with client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[{"role": "user", "content": "private"}],
                max_completion_tokens=8,
                stream=True,
            ) as stream:
                events = list(stream)
        _end_llm(handler, run_id)
        handler.on_llm_error(RuntimeError("late duplicate"), run_id=run_id)
        client.close()

    assert events == [_exact_openai_stream_event()]
    assert resource.calls == 1
    assert len(reserves) == 1
    assert len(commits) == 1
    assert commits[0][1]["actual_input_tokens"] == 4
    assert commits[0][1]["actual_output_tokens"] == 2
    assert releases == []
    assert resource.streams[0].close_calls == 1
    assert [warning for warning in emitted if "control scope" in str(warning.message)] == []
    assert telemetry.buffer_size() == 0


@pytest.mark.asyncio
async def test_async_streaming_wrapper_settles_once_and_suppresses_duplicate_callback_telemetry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    handler = AsyncPylvaCallbackHandler(
        api_key=KEY_A,
        endpoint="https://unit.invalid",
        local_mode=True,
        control={"mode": "enforce", "on_unavailable": "deny"},
    )
    run_id = uuid.uuid4()
    resource = _AsyncStreamingCompletions()
    reserves: list[dict[str, Any]] = []
    commits: list[tuple[str, dict[str, Any]]] = []
    releases: list[object] = []

    async def reserve(request: dict[str, Any]) -> ReservedBudgetDecision:
        reserves.append(request)
        return _reserved_decision(request)

    async def commit(reservation_id: str, request: dict[str, Any]) -> None:
        commits.append((reservation_id, request))

    async def release(*args: object) -> None:
        releases.append(args)

    monkeypatch.setattr(control_client, "reserve_usage", reserve)
    monkeypatch.setattr(control_client, "commit_usage", commit)
    monkeypatch.setattr(control_client, "release_usage", release)
    client = wrap_openai(_DeniedOpenAIClient(resource))

    with warnings.catch_warnings(record=True) as emitted:
        warnings.simplefilter("always")
        with langgraph_control_scope():
            await handler.on_chat_model_start(
                {"name": "ChatOpenAI"},
                [[object()]],
                run_id=run_id,
                metadata={
                    "pylva_customer_id": "customer_acme",
                    "langgraph_node": "call_model",
                    "ls_provider": "openai",
                    "ls_model_name": "gpt-4o-mini",
                },
            )
            stream = await client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[{"role": "user", "content": "private"}],
                max_completion_tokens=8,
                stream=True,
            )
            async with stream:
                events = [event async for event in stream]
        await handler.on_llm_end(_Response(), run_id=run_id)
        await handler.on_llm_error(RuntimeError("late duplicate"), run_id=run_id)
        await client.close()

    assert events == [_exact_openai_stream_event()]
    assert resource.calls == 1
    assert len(reserves) == 1
    assert len(commits) == 1
    assert commits[0][1]["actual_input_tokens"] == 4
    assert commits[0][1]["actual_output_tokens"] == 2
    assert releases == []
    assert resource.streams[0].close_calls == 1
    assert [warning for warning in emitted if "control scope" in str(warning.message)] == []
    assert telemetry.buffer_size() == 0


def test_sync_reserve_denial_links_callback_without_dispatch_or_legacy_event(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    handler = PylvaCallbackHandler(
        api_key=KEY_A,
        endpoint="https://unit.invalid",
        local_mode=True,
        control={"mode": "enforce", "on_unavailable": "deny"},
    )
    run_id = uuid.uuid4()
    resource = _DeniedSyncCompletions()

    def deny(_body: dict[str, Any]) -> object:
        raise _authoritative_denial()

    monkeypatch.setattr(control_client, "reserve_usage_sync", deny)
    with langgraph_control_scope():
        _start_llm(handler, run_id)
        with pytest.raises(PylvaBudgetExceeded) as caught:
            wrap_openai(_DeniedOpenAIClient(resource)).chat.completions.create(
                model="gpt-4o-mini",
                messages=[{"role": "user", "content": "private"}],
                max_completion_tokens=8,
            )
    handler.on_llm_error(caught.value, run_id=run_id)

    assert resource.calls == 0
    assert telemetry.buffer_size() == 0


@pytest.mark.asyncio
async def test_async_reserve_denial_links_callback_without_dispatch_or_legacy_event(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    handler = AsyncPylvaCallbackHandler(
        api_key=KEY_A,
        endpoint="https://unit.invalid",
        local_mode=True,
        control={"mode": "enforce", "on_unavailable": "deny"},
    )
    run_id = uuid.uuid4()
    resource = _DeniedAsyncCompletions()

    async def deny(_body: dict[str, Any]) -> object:
        raise _authoritative_denial()

    monkeypatch.setattr(control_client, "reserve_usage", deny)
    with langgraph_control_scope():
        await handler.on_chat_model_start(
            {"name": "ChatOpenAI"},
            [[object()]],
            run_id=run_id,
            metadata={
                "pylva_customer_id": "customer_acme",
                "langgraph_node": "call_model",
                "ls_provider": "openai",
                "ls_model_name": "gpt-4o-mini",
            },
        )
        with pytest.raises(PylvaBudgetExceeded) as caught:
            await wrap_openai(_DeniedOpenAIClient(resource)).chat.completions.create(
                model="gpt-4o-mini",
                messages=[{"role": "user", "content": "private"}],
                max_completion_tokens=8,
            )
    await handler.on_llm_error(caught.value, run_id=run_id)

    assert resource.calls == 0
    assert telemetry.buffer_size() == 0


@pytest.mark.parametrize("provider", ["openai", "anthropic"])
def test_sync_local_strict_refusal_links_callback_without_dispatch_or_legacy_event(
    provider: str,
) -> None:
    handler = PylvaCallbackHandler(
        api_key=KEY_A,
        endpoint="https://unit.invalid",
        local_mode=True,
        control={"mode": "enforce", "on_unavailable": "deny"},
    )
    run_id = uuid.uuid4()
    resource = _DeniedSyncCompletions()
    if provider == "openai":
        client = wrap_openai(_DeniedOpenAIClient(resource))

        def invoke() -> object:
            return client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[{"role": "user", "content": "private"}],
                max_completion_tokens=8,
                unsupported_paid_feature=True,
            )

    else:
        client = wrap_anthropic(_DeniedAnthropicClient(resource))

        def invoke() -> object:
            return client.messages.create(
                model="claude-3-5-haiku-latest",
                messages=[{"role": "user", "content": "private"}],
                max_tokens=8,
                unsupported_paid_feature=True,
            )

    with langgraph_control_scope():
        _start_llm(handler, run_id)
        with pytest.raises(PylvaStrictProviderError) as caught:
            invoke()
    handler.on_llm_error(caught.value, run_id=run_id)

    assert resource.calls == 0
    assert telemetry.buffer_size() == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("provider", ["openai", "anthropic"])
async def test_async_local_strict_refusal_links_callback_without_dispatch_or_legacy_event(
    provider: str,
) -> None:
    handler = AsyncPylvaCallbackHandler(
        api_key=KEY_A,
        endpoint="https://unit.invalid",
        local_mode=True,
        control={"mode": "enforce", "on_unavailable": "deny"},
    )
    run_id = uuid.uuid4()
    resource = _DeniedAsyncCompletions()
    if provider == "openai":
        client = wrap_openai(_DeniedOpenAIClient(resource))

        async def invoke() -> object:
            return await client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[{"role": "user", "content": "private"}],
                max_completion_tokens=8,
                unsupported_paid_feature=True,
            )

    else:
        client = wrap_anthropic(_DeniedAnthropicClient(resource))

        async def invoke() -> object:
            return await client.messages.create(
                model="claude-3-5-haiku-latest",
                messages=[{"role": "user", "content": "private"}],
                max_tokens=8,
                unsupported_paid_feature=True,
            )

    with langgraph_control_scope():
        await handler.on_chat_model_start(
            {"name": "ChatOpenAI"},
            [[object()]],
            run_id=run_id,
            metadata={
                "pylva_customer_id": "customer_acme",
                "langgraph_node": "call_model",
            },
        )
        with pytest.raises(PylvaStrictProviderError) as caught:
            await invoke()
    await handler.on_llm_error(caught.value, run_id=run_id)

    assert resource.calls == 0
    assert telemetry.buffer_size() == 0


def test_post_dispatch_strict_error_keeps_attempt_ownership_without_zero_pending_warning() -> None:
    handler = PylvaCallbackHandler()
    run_id = uuid.uuid4()

    with warnings.catch_warnings(record=True) as caught_warnings:
        warnings.simplefilter("always")
        with langgraph_control_scope():
            _start_llm(handler, run_id)
            with _controlled_attempt_scope(_llm_attempt()):
                error = controlled_provider._strict_error("openai", "invalid_client")
        handler.on_llm_error(error, run_id=run_id)

    assert caught_warnings == []
    assert telemetry.buffer_size() == 0


def test_post_dispatch_strict_error_does_not_steal_a_later_pending_callback() -> None:
    handler = PylvaCallbackHandler()
    owned_run_id = uuid.uuid4()
    later_run_id = uuid.uuid4()

    with langgraph_control_scope():
        _start_llm(handler, owned_run_id)
        with _controlled_attempt_scope(_llm_attempt()):
            pass
        _start_llm(handler, later_run_id)
        error = controlled_provider._strict_error("openai", "invalid_client")
    handler.on_llm_error(error, run_id=owned_run_id)
    handler.on_llm_error(error, run_id=later_run_id)

    # The post-dispatch error belongs to the first controlled attempt. The later
    # unlinked callback remains callback-owned and therefore emits one event.
    assert telemetry.buffer_size() == 1


def test_public_scope_links_callback_first_controlled_tool() -> None:
    handler = PylvaCallbackHandler(track_tool_calls=True)
    run_id = uuid.uuid4()

    with langgraph_control_scope():
        handler.on_tool_start(
            {"name": "tavily_search"},
            "PRIVATE QUERY",
            run_id=run_id,
            metadata={"langgraph_node": "search"},
        )
        with _controlled_attempt_scope(_tool_attempt()):
            pass
    handler.on_tool_end("PRIVATE RESULT", run_id=run_id)

    assert telemetry.buffer_size() == 0


def test_sync_tool_denial_links_callback_without_dispatch_or_legacy_event(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    handler = PylvaCallbackHandler(
        api_key=KEY_A,
        endpoint="https://unit.invalid",
        local_mode=True,
        control={"mode": "enforce", "on_unavailable": "deny"},
        track_tool_calls=True,
    )
    run_id = uuid.uuid4()
    calls = 0

    def deny(_body: dict[str, object]) -> object:
        raise _authoritative_denial()

    def invoke() -> dict[str, object]:
        nonlocal calls
        calls += 1
        return {"usage": {"credits": 1}}

    monkeypatch.setattr(controlled_usage_subject, "reserve_usage_sync", deny)
    with langgraph_control_scope():
        handler.on_tool_start(
            {"name": "tavily_search"},
            "PRIVATE QUERY",
            run_id=run_id,
            metadata={"langgraph_node": "search"},
        )
        with pytest.raises(PylvaBudgetExceeded) as caught:
            pylva.controlled_usage_sync(
                cost_source_slug="tavily-search",
                tool_name="tavily_search",
                metric="credit",
                maximum_value=1,
                customer_id="customer_acme",
                invoke=invoke,
                extract_actual=lambda _response: 1,
            )
    handler.on_tool_error(caught.value, run_id=run_id, name="tavily_search")

    assert calls == 0
    assert telemetry.buffer_size() == 0


@pytest.mark.asyncio
async def test_async_tool_denial_links_callback_without_dispatch_or_legacy_event(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    handler = AsyncPylvaCallbackHandler(
        api_key=KEY_A,
        endpoint="https://unit.invalid",
        local_mode=True,
        control={"mode": "enforce", "on_unavailable": "deny"},
        track_tool_calls=True,
    )
    run_id = uuid.uuid4()
    calls = 0

    async def deny(_body: dict[str, object]) -> object:
        raise _authoritative_denial()

    async def invoke() -> dict[str, object]:
        nonlocal calls
        calls += 1
        return {"usage": {"credits": 1}}

    monkeypatch.setattr(controlled_usage_subject, "reserve_usage", deny)
    with langgraph_control_scope():
        await handler.on_tool_start(
            {"name": "tavily_search"},
            "PRIVATE QUERY",
            run_id=run_id,
            metadata={"langgraph_node": "search"},
        )
        with pytest.raises(PylvaBudgetExceeded) as caught:
            await pylva.controlled_usage(
                cost_source_slug="tavily-search",
                tool_name="tavily_search",
                metric="credit",
                maximum_value=1,
                customer_id="customer_acme",
                invoke=invoke,
                extract_actual=lambda _response: 1,
            )
    await handler.on_tool_error(caught.value, run_id=run_id, name="tavily_search")

    assert calls == 0
    assert telemetry.buffer_size() == 0


def test_sync_tavily_local_validation_refusal_links_callback_without_dispatch() -> None:
    handler = PylvaCallbackHandler(
        api_key=KEY_A,
        endpoint="https://unit.invalid",
        local_mode=True,
        control={"mode": "enforce", "on_unavailable": "deny"},
        track_tool_calls=True,
    )
    run_id = uuid.uuid4()
    client = _DeniedSyncTavilyClient()

    with langgraph_control_scope():
        handler.on_tool_start(
            {"name": "tavily_search"},
            "PRIVATE QUERY",
            run_id=run_id,
            metadata={"langgraph_node": "search"},
        )
        with pytest.raises(PylvaControlValidationError) as caught:
            controlled_tavily_search_sync(
                client,
                "private query",
                customer_id="customer_acme",
                search_options={"searchDepth": "advanced"},
            )
    handler.on_tool_error(caught.value, run_id=run_id, name="tavily_search")

    assert client.calls == 0
    assert telemetry.buffer_size() == 0


@pytest.mark.asyncio
async def test_async_tavily_local_validation_refusal_links_callback_without_dispatch() -> None:
    handler = AsyncPylvaCallbackHandler(
        api_key=KEY_A,
        endpoint="https://unit.invalid",
        local_mode=True,
        control={"mode": "enforce", "on_unavailable": "deny"},
        track_tool_calls=True,
    )
    run_id = uuid.uuid4()
    client = _DeniedAsyncTavilyClient()

    with langgraph_control_scope():
        await handler.on_tool_start(
            {"name": "tavily_search"},
            "PRIVATE QUERY",
            run_id=run_id,
            metadata={"langgraph_node": "search"},
        )
        with pytest.raises(PylvaControlValidationError) as caught:
            await controlled_tavily_search(
                client,
                "private query",
                customer_id="customer_acme",
                search_options={"searchDepth": "advanced"},
            )
    await handler.on_tool_error(caught.value, run_id=run_id, name="tavily_search")

    assert client.calls == 0
    assert telemetry.buffer_size() == 0


def test_sync_generic_local_validation_refusal_links_callback_without_dispatch() -> None:
    handler = PylvaCallbackHandler(
        api_key=KEY_A,
        endpoint="https://unit.invalid",
        local_mode=True,
        control={"mode": "enforce", "on_unavailable": "deny"},
        track_tool_calls=True,
    )
    run_id = uuid.uuid4()
    calls = 0

    def invoke() -> object:
        nonlocal calls
        calls += 1
        return object()

    with langgraph_control_scope():
        handler.on_tool_start(
            {"name": "generic_tool"},
            "PRIVATE INPUT",
            run_id=run_id,
            metadata={"langgraph_node": "tool"},
        )
        with pytest.raises(PylvaControlValidationError) as caught:
            pylva.controlled_usage_sync(
                cost_source_slug="generic",
                tool_name="generic_tool",
                metric="calls",
                maximum_value=-1,
                customer_id="customer_acme",
                invoke=invoke,
                extract_actual=lambda _response: 1,
            )
    handler.on_tool_error(caught.value, run_id=run_id, name="generic_tool")

    assert calls == 0
    assert telemetry.buffer_size() == 0


@pytest.mark.asyncio
async def test_async_generic_local_validation_refusal_links_callback_without_dispatch() -> None:
    handler = AsyncPylvaCallbackHandler(
        api_key=KEY_A,
        endpoint="https://unit.invalid",
        local_mode=True,
        control={"mode": "enforce", "on_unavailable": "deny"},
        track_tool_calls=True,
    )
    run_id = uuid.uuid4()
    calls = 0

    async def invoke() -> object:
        nonlocal calls
        calls += 1
        return object()

    with langgraph_control_scope():
        await handler.on_tool_start(
            {"name": "generic_tool"},
            "PRIVATE INPUT",
            run_id=run_id,
            metadata={"langgraph_node": "tool"},
        )
        with pytest.raises(PylvaControlValidationError) as caught:
            await pylva.controlled_usage(
                cost_source_slug="generic",
                tool_name="generic_tool",
                metric="calls",
                maximum_value=-1,
                customer_id="customer_acme",
                invoke=invoke,
                extract_actual=lambda _response: 1,
            )
    await handler.on_tool_error(caught.value, run_id=run_id, name="generic_tool")

    assert calls == 0
    assert telemetry.buffer_size() == 0


def test_inherited_outer_llm_cannot_hide_nested_unwrapped_callback() -> None:
    handler = PylvaCallbackHandler()
    run_id = uuid.uuid4()

    with _controlled_attempt_scope(_llm_attempt()):
        with langgraph_control_scope():
            _start_llm(handler, run_id)
    _end_llm(handler, run_id)

    assert telemetry.buffer_size() == 1


def test_nested_callback_links_to_inner_controlled_llm() -> None:
    handler = PylvaCallbackHandler()
    run_id = uuid.uuid4()

    with _controlled_attempt_scope(_llm_attempt()):
        with langgraph_control_scope():
            _start_llm(handler, run_id)
            with _controlled_attempt_scope(_llm_attempt()):
                pass
    _end_llm(handler, run_id)

    assert telemetry.buffer_size() == 0


def test_public_scope_never_guesses_with_multiple_pending_callbacks() -> None:
    handler = PylvaCallbackHandler()
    run_ids = [uuid.uuid4(), uuid.uuid4()]

    with pytest.warns(RuntimeWarning, match="found 2 pending llm callbacks"):
        with langgraph_control_scope():
            for run_id in run_ids:
                _start_llm(handler, run_id)
            with _controlled_attempt_scope(_llm_attempt()):
                pass
    for run_id in run_ids:
        _end_llm(handler, run_id)

    assert telemetry.buffer_size() == 2


def test_public_scope_warns_when_provider_has_no_pending_callback() -> None:
    with pytest.warns(RuntimeWarning, match="found 0 pending llm callbacks"):
        with langgraph_control_scope(), _controlled_attempt_scope(_llm_attempt()):
            pass

    assert telemetry.buffer_size() == 0


def test_warning_filter_cannot_block_provider_dispatch() -> None:
    called = False

    with warnings.catch_warnings():
        warnings.simplefilter("error", RuntimeWarning)
        with langgraph_control_scope(), _controlled_attempt_scope(_llm_attempt()):
            called = True

    assert called is True
    assert telemetry.buffer_size() == 0


@pytest.mark.asyncio
async def test_inherited_attempt_lease_is_inactive_after_parent_scope_exits() -> None:
    handler = AsyncPylvaCallbackHandler()
    run_id = uuid.uuid4()
    gate = asyncio.Event()

    async def orphan() -> None:
        await gate.wait()
        await handler.on_chat_model_start({"name": "ChatOpenAI"}, [[object()]], run_id=run_id)

    with _controlled_attempt_scope(_llm_attempt()):
        task = asyncio.create_task(orphan())
    gate.set()
    await task
    await handler.on_llm_end(_Response(), run_id=run_id)

    assert telemetry.buffer_size() == 1


@pytest.mark.asyncio
async def test_inherited_public_scope_is_inactive_after_parent_scope_exits() -> None:
    handler = AsyncPylvaCallbackHandler()
    run_id = uuid.uuid4()
    gate = asyncio.Event()

    async def orphan() -> None:
        await gate.wait()
        await handler.on_chat_model_start({"name": "ChatOpenAI"}, [[object()]], run_id=run_id)
        with _controlled_attempt_scope(_llm_attempt()):
            pass

    with langgraph_control_scope():
        task = asyncio.create_task(orphan())
    gate.set()
    await task
    await handler.on_llm_end(_Response(), run_id=run_id)

    assert telemetry.buffer_size() == 1
