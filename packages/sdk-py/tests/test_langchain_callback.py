"""LangChain/LangGraph callback handler coverage.

The tests call handler methods directly so they do not need LangChain as a
test dependency. Real apps get the BaseCallbackHandler subclass when
``pylva-sdk[langchain]`` is installed.
"""

from __future__ import annotations

import uuid
from typing import Any

import pytest

from pylva.core import non_llm_policy as policy_mod
from pylva.core import telemetry
from pylva.core.config import init as init_config
from pylva.core.context import track_context
from pylva.langchain import AsyncPylvaCallbackHandler, PylvaCallbackHandler
from pylva.langchain import callback as callback_mod

VALID_KEY = "pv_live_12345678_" + "a" * 32


class _FakeMessage:
    def __init__(
        self,
        *,
        usage_metadata: dict[str, int] | None = None,
        response_metadata: dict[str, str] | None = None,
        content: str = "SECRET COMPLETION TEXT",
    ) -> None:
        self.usage_metadata = usage_metadata
        self.response_metadata = response_metadata or {}
        self.content = content


class _FakeGeneration:
    def __init__(self, message: _FakeMessage) -> None:
        self.message = message


class _FakeResponse:
    def __init__(
        self,
        *,
        usage_metadata: dict[str, int] | None = None,
        response_metadata: dict[str, str] | None = None,
        llm_output: dict[str, Any] | None = None,
    ) -> None:
        self.generations = [
            [
                _FakeGeneration(
                    _FakeMessage(
                        usage_metadata=usage_metadata,
                        response_metadata=response_metadata,
                    )
                )
            ]
        ]
        self.llm_output = llm_output


class _FakeHttpResponse:
    def __init__(self, status_code: int, payload: dict[str, Any]) -> None:
        self.status_code = status_code
        self._payload = payload

    def json(self) -> dict[str, Any]:
        return self._payload


class _FakeHttpClient:
    def __init__(self, posts: list[str]) -> None:
        self.posts = posts

    def __enter__(self) -> _FakeHttpClient:
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def get(self, *_args: Any, **_kwargs: Any) -> _FakeHttpResponse:
        return _FakeHttpResponse(
            200,
            {
                "version": "test",
                "refresh_after_ms": 10_000,
                "unknown_behavior": "discover_only",
                "sources": [],
            },
        )

    def post(self, *_args: Any, **kwargs: Any) -> _FakeHttpResponse:
        content = kwargs.get("content")
        assert isinstance(content, str)
        self.posts.append(content)
        return _FakeHttpResponse(200, {"accepted": 1, "rejected": 0})


def setup_function(_fn: object) -> None:
    telemetry._reset_telemetry_for_tests()  # type: ignore[attr-defined]


def _serialized(name: str = "ChatOpenAI") -> dict[str, Any]:
    return {"name": name, "id": ["langchain", "chat_models", name]}


def test_callback_extracts_usage_metadata_and_langgraph_attribution() -> None:
    handler = PylvaCallbackHandler(api_key=VALID_KEY, local_mode=True)
    chain_run_id = uuid.uuid4()
    llm_run_id = uuid.uuid4()
    prompt = "SECRET PROMPT TEXT"

    handler.on_chain_start(
        _serialized("LangGraph"),
        {"input": prompt},
        run_id=chain_run_id,
        metadata={"pylva_customer_id": "cust_42", "langgraph_node": "planner"},
    )
    handler.on_chat_model_start(
        _serialized(),
        [[object()]],
        run_id=llm_run_id,
        parent_run_id=chain_run_id,
        metadata={
            "pylva_customer_id": "cust_42",
            "langgraph_node": "planner",
            "ls_provider": "openai",
            "ls_model_name": "gpt-4o-mini",
        },
    )
    handler.on_llm_end(
        _FakeResponse(
            usage_metadata={"input_tokens": 17, "output_tokens": 9, "total_tokens": 26},
            response_metadata={"model_name": "gpt-4o-mini", "provider": "openai"},
        ),
        run_id=llm_run_id,
        parent_run_id=chain_run_id,
    )

    assert telemetry.buffer_size() == 1
    event = telemetry._state.buffer[0]  # type: ignore[attr-defined]
    assert event["customer_id"] == "cust_42"
    assert event["step_name"] == "planner"
    assert event["framework"] == "langgraph"
    assert event["provider"] == "openai"
    assert event["model"] == "gpt-4o-mini"
    assert event["tokens_in"] == 17
    assert event["tokens_out"] == 9
    assert event["run_id"] == str(llm_run_id)
    assert event["parent_run_id"] == str(chain_run_id)
    assert event["trace_id"] == str(chain_run_id)
    assert event["span_id"] == str(llm_run_id)
    assert event["parent_span_id"] == str(chain_run_id)
    assert event["metadata"]["token_count_source"] == "exact"
    assert not any(prompt in str(value) for value in event.values())


def test_callback_falls_back_to_llm_output_token_usage() -> None:
    handler = PylvaCallbackHandler(api_key=VALID_KEY, local_mode=True)
    run_id = uuid.uuid4()

    handler.on_llm_start(
        _serialized("OpenAI"),
        ["prompt not captured"],
        run_id=run_id,
        metadata={"customer_id": "cust_1", "langgraph_node": "summarize"},
    )
    handler.on_llm_end(
        _FakeResponse(
            llm_output={
                "model_name": "gpt-4o-mini",
                "token_usage": {"prompt_tokens": 11, "completion_tokens": 4},
            }
        ),
        run_id=run_id,
    )

    event = telemetry._state.buffer[0]  # type: ignore[attr-defined]
    assert event["tokens_in"] == 11
    assert event["tokens_out"] == 4
    assert event["model"] == "gpt-4o-mini"
    assert event["metadata"]["token_count_source"] == "exact"


def test_callback_marks_missing_usage_without_prompt_capture() -> None:
    handler = PylvaCallbackHandler(api_key=VALID_KEY, local_mode=True)
    run_id = uuid.uuid4()

    handler.on_llm_start(
        _serialized("ChatAnthropic"),
        ["SECRET PROMPT"],
        run_id=run_id,
        metadata={"customer_id": "cust_1", "langgraph_node": "draft_reply"},
    )
    handler.on_llm_end(_FakeResponse(), run_id=run_id)

    event = telemetry._state.buffer[0]  # type: ignore[attr-defined]
    assert event["tokens_in"] == 0
    assert event["tokens_out"] == 0
    assert event["metadata"]["usage_missing"] is True
    assert "token_count_source" not in event["metadata"]
    assert not any("SECRET PROMPT" in str(value) for value in event.values())


def test_callback_drops_unsafe_allowed_metadata_values_before_capture() -> None:
    handler = PylvaCallbackHandler(api_key=VALID_KEY, local_mode=True)
    run_id = uuid.uuid4()
    secret = "SECRET PROMPT SHOULD NOT LEAVE PROCESS"

    handler.on_llm_start(
        _serialized(),
        ["prompt not captured"],
        run_id=run_id,
        metadata={
            "customer_id": "cust_1",
            "langgraph_node": secret,
            "langgraph_step": ["unsafe", secret],
            "pylva_step": "draft reply",
            "ls_provider": "OPENAI",
            "ls_model_name": {"model": secret},
            "unsafe_prompt_copy": secret,
        },
    )
    handler.on_llm_end(_FakeResponse(), run_id=run_id)

    event = telemetry._state.buffer[0]  # type: ignore[attr-defined]
    assert event["step_name"] == "ChatOpenAI"
    assert event["provider"] == "OPENAI"
    assert event["metadata"] == {
        "ls_provider": "OPENAI",
        "usage_missing": True,
    }
    assert secret not in str(event)
    assert "langgraph_node" not in event["metadata"]
    assert "langgraph_step" not in event["metadata"]
    assert "pylva_step" not in event["metadata"]


def test_callback_keeps_identifier_like_metadata_step_labels() -> None:
    handler = PylvaCallbackHandler(api_key=VALID_KEY, local_mode=True)
    run_id = uuid.uuid4()

    handler.on_llm_start(
        _serialized(),
        ["prompt not captured"],
        run_id=run_id,
        metadata={
            "customer_id": "cust_1",
            "langgraph_node": "planner_node",
            "langgraph_step": "graph/call_model",
            "pylva_step": "draft-reply",
            "ls_provider": "OPENAI",
            "ls_model_name": "gpt-4o-mini",
        },
    )
    handler.on_llm_end(
        _FakeResponse(
            usage_metadata={"input_tokens": 3, "output_tokens": 2},
            response_metadata={"model_name": "gpt-4o-mini", "provider": "openai"},
        ),
        run_id=run_id,
    )

    event = telemetry._state.buffer[0]  # type: ignore[attr-defined]
    assert event["step_name"] == "planner_node"
    assert event["metadata"] == {
        "langgraph_node": "planner_node",
        "langgraph_step": "graph/call_model",
        "pylva_step": "draft-reply",
        "ls_provider": "OPENAI",
        "ls_model_name": "gpt-4o-mini",
        "token_count_source": "exact",
    }


def test_callback_preserves_flexible_provider_model_identifiers() -> None:
    handler = PylvaCallbackHandler(api_key=VALID_KEY, local_mode=True)
    run_id = uuid.uuid4()
    model = "ft:gpt-4o-mini:org/name+v1@prod"

    handler.on_chat_model_start(
        _serialized("ChatOpenAI"),
        [[object()]],
        run_id=run_id,
        metadata={
            "customer_id": "cust_1",
            "langgraph_node": "planner_node",
            "ls_provider": "openai.chat",
            "ls_model_name": model,
        },
    )
    handler.on_llm_end(
        _FakeResponse(
            usage_metadata={"input_tokens": 5, "output_tokens": 7},
            response_metadata={"model_name": model, "provider": "openai.chat"},
        ),
        run_id=run_id,
    )

    event = telemetry._state.buffer[0]  # type: ignore[attr-defined]
    assert event["provider"] == "openai.chat"
    assert event["model"] == model
    assert event["metadata"]["ls_provider"] == "openai.chat"
    assert event["metadata"]["ls_model_name"] == model


def test_callback_preserves_invocation_param_provider_model() -> None:
    handler = PylvaCallbackHandler(api_key=VALID_KEY, local_mode=True)
    run_id = uuid.uuid4()

    handler.on_llm_start(
        _serialized("ChatOllama"),
        ["prompt not captured"],
        run_id=run_id,
        metadata={"customer_id": "cust_1"},
        invocation_params={
            "provider": "ollama",
            "model": "ollama/llama3.1-8b",
        },
    )
    handler.on_llm_end(_FakeResponse(), run_id=run_id)

    event = telemetry._state.buffer[0]  # type: ignore[attr-defined]
    assert event["provider"] == "ollama"
    assert event["model"] == "ollama/llama3.1-8b"


def test_constructor_customer_id_wins_then_metadata_then_context() -> None:
    constructor_handler = PylvaCallbackHandler(
        api_key=VALID_KEY,
        local_mode=True,
        customer_id="cust_constructor",
    )
    run_id = uuid.uuid4()
    with track_context("cust_context"):
        constructor_handler.on_llm_start(
            _serialized(),
            ["prompt"],
            run_id=run_id,
            metadata={"pylva_customer_id": "cust_metadata"},
        )
    constructor_handler.on_llm_end(_FakeResponse(), run_id=run_id)
    assert telemetry._state.buffer[0]["customer_id"] == "cust_constructor"  # type: ignore[attr-defined]

    telemetry._reset_telemetry_for_tests()  # type: ignore[attr-defined]
    metadata_handler = PylvaCallbackHandler(api_key=VALID_KEY, local_mode=True)
    run_id = uuid.uuid4()
    with track_context("cust_context"):
        metadata_handler.on_llm_start(
            _serialized(),
            ["prompt"],
            run_id=run_id,
            metadata={"customer_id": "cust_metadata"},
        )
    metadata_handler.on_llm_end(_FakeResponse(), run_id=run_id)
    assert telemetry._state.buffer[0]["customer_id"] == "cust_metadata"  # type: ignore[attr-defined]

    telemetry._reset_telemetry_for_tests()  # type: ignore[attr-defined]
    context_handler = PylvaCallbackHandler(api_key=VALID_KEY, local_mode=True)
    run_id = uuid.uuid4()
    with track_context("cust_context"):
        context_handler.on_llm_start(_serialized(), ["prompt"], run_id=run_id)
        context_handler.on_llm_end(_FakeResponse(), run_id=run_id)
    assert telemetry._state.buffer[0]["customer_id"] == "cust_context"  # type: ignore[attr-defined]


def test_callback_emits_failure_without_error_message() -> None:
    handler = PylvaCallbackHandler(api_key=VALID_KEY, local_mode=True)
    run_id = uuid.uuid4()

    handler.on_llm_start(
        _serialized("ChatOpenAI"),
        ["prompt"],
        run_id=run_id,
        metadata={"customer_id": "cust_1", "langgraph_node": "classify"},
    )
    handler.on_llm_error(RuntimeError("SECRET ERROR MESSAGE"), run_id=run_id)

    event = telemetry._state.buffer[0]  # type: ignore[attr-defined]
    assert event["status"] == "failure"
    assert event["tokens_in"] == 0
    assert event["tokens_out"] == 0
    assert event["metadata"]["error_type"] == "RuntimeError"
    assert not any("SECRET ERROR MESSAGE" in str(value) for value in event.values())


def test_tool_calls_are_opt_in_reported_usage() -> None:
    run_id = uuid.uuid4()
    parent_run_id = uuid.uuid4()
    handler = PylvaCallbackHandler(api_key=VALID_KEY, local_mode=True)
    handler.on_tool_end("SECRET TOOL OUTPUT", run_id=run_id, parent_run_id=parent_run_id)
    assert telemetry.buffer_size() == 0

    tracked = PylvaCallbackHandler(api_key=VALID_KEY, local_mode=True, track_tool_calls=True)
    tracked.on_tool_start(
        {"name": "lookup_account"},
        "SECRET TOOL INPUT",
        run_id=run_id,
        parent_run_id=parent_run_id,
        metadata={"customer_id": "cust_1", "langgraph_node": "lookup"},
    )
    tracked.on_tool_end("SECRET TOOL OUTPUT", run_id=run_id, parent_run_id=parent_run_id)

    event = telemetry._state.buffer[0]  # type: ignore[attr-defined]
    assert event["instrumentation_tier"] == "reported"
    assert event["cost_source"] == "configured"
    assert event["metric"] == "calls"
    assert event["metric_value"] == 1
    assert event["tool_name"] == "lookup_account"
    assert not any("SECRET TOOL" in str(value) for value in event.values())


def test_policy_mode_tracks_approved_tool_and_uses_extractor() -> None:
    run_id = uuid.uuid4()
    parent_run_id = uuid.uuid4()

    def extractor(ctx: policy_mod.NonLlmToolContext) -> int:
        assert ctx.input == "SECRET TOOL INPUT"
        assert ctx.output == {"secret": "SECRET TOOL OUTPUT"}
        return 7

    handler = PylvaCallbackHandler(
        api_key=VALID_KEY,
        local_mode=True,
        non_llm={
            "mode": "policy",
            "policy": {
                "sources": [
                    {
                        "slug": "tavily",
                        "status": "tracked",
                        "matchers": ["tavily_search"],
                        "metric": "tavily_requests",
                        "unit": "request",
                        "default_metric_value": 1,
                    }
                ]
            },
            "usage_extractors": {"tavily": extractor},
        },
    )
    handler.on_tool_start(
        {"name": "safe_wrapper"},
        "SECRET TOOL INPUT",
        run_id=run_id,
        parent_run_id=parent_run_id,
        metadata={
            "customer_id": "cust_1",
            "langgraph_node": "lookup",
            "pylva_tool": "tavily_search",
        },
    )
    handler.on_tool_end(
        {"secret": "SECRET TOOL OUTPUT"},
        run_id=run_id,
        parent_run_id=parent_run_id,
    )

    event = telemetry._state.buffer[0]  # type: ignore[attr-defined]
    assert event["instrumentation_tier"] == "reported"
    assert event["cost_source"] == "configured"
    assert event["provider"] is None
    assert event["metric"] == "tavily_requests"
    assert event["metric_value"] == 7
    assert event["tool_name"] == "safe_wrapper"
    assert "pylva_tool" not in event["metadata"]
    assert not any("SECRET TOOL" in str(value) for value in event.values())


def test_policy_mode_ignores_ignored_tool() -> None:
    handler = PylvaCallbackHandler(
        api_key=VALID_KEY,
        local_mode=True,
        non_llm={
            "mode": "policy",
            "policy": {
                "sources": [
                    {"slug": "grep", "status": "ignored", "matchers": ["grep"]},
                ]
            },
        },
    )
    run_id = uuid.uuid4()

    handler.on_tool_start(
        {"name": "grep"},
        "SECRET TOOL INPUT",
        run_id=run_id,
        metadata={"customer_id": "cust_1", "langgraph_node": "tools"},
    )
    handler.on_tool_end("SECRET TOOL OUTPUT", run_id=run_id)

    assert telemetry.buffer_size() == 0


def test_policy_mode_unknown_tool_posts_discovery_only(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    posts: list[str] = []
    monkeypatch.setattr(policy_mod.httpx, "Client", lambda *_a, **_kw: _FakeHttpClient(posts))
    init_config(VALID_KEY, endpoint="http://mock")
    policy_mod.ensure_non_llm_policy()
    handler = PylvaCallbackHandler(non_llm={"mode": "policy"})
    run_id = uuid.uuid4()

    handler.on_tool_start(
        {"name": "local_lookup"},
        "SECRET TOOL INPUT",
        run_id=run_id,
        metadata={"customer_id": "cust_1", "langgraph_node": "tools"},
    )
    handler.on_tool_end("SECRET TOOL OUTPUT", run_id=run_id)
    policy_mod.flush_non_llm_discoveries()

    assert telemetry.buffer_size() == 0
    assert len(posts) == 1
    assert '"tool_name": "local_lookup"' in posts[0]
    assert '"matcher": "local_lookup"' in posts[0]
    assert "SECRET" not in posts[0]


def test_policy_mode_dedupes_duplicate_tool_end_and_handles_missing_start() -> None:
    handler = PylvaCallbackHandler(
        api_key=VALID_KEY,
        local_mode=True,
        non_llm={
            "mode": "policy",
            "policy": {
                "sources": [
                    {
                        "slug": "tool",
                        "status": "tracked",
                        "matchers": ["tool", "tavily_search"],
                        "metric": "tool_calls",
                        "unit": "request",
                        "default_metric_value": 1,
                    }
                ]
            },
        },
    )
    run_id = uuid.uuid4()

    handler.on_tool_start(
        {"name": "tavily_search"},
        "SECRET TOOL INPUT",
        run_id=run_id,
        metadata={"customer_id": "cust_1"},
    )
    handler.on_tool_end("SECRET TOOL OUTPUT", run_id=run_id)
    handler.on_tool_end("SECRET TOOL OUTPUT", run_id=run_id)
    assert telemetry.buffer_size() == 1

    handler.on_tool_end("SECRET TOOL OUTPUT", run_id=uuid.uuid4())
    assert telemetry.buffer_size() == 2
    fallback_event = telemetry._state.buffer[1]  # type: ignore[attr-defined]
    assert fallback_event["tool_name"] == "tool"
    assert fallback_event["metric"] == "tool_calls"


def test_tool_error_cleans_run_and_reports_failure_without_capturing_input() -> None:
    handler = PylvaCallbackHandler(api_key=VALID_KEY, local_mode=True, track_tool_calls=True)
    run_id = uuid.uuid4()
    parent_run_id = uuid.uuid4()

    handler.on_tool_start(
        {"name": "search_tool"},
        "SECRET TOOL INPUT",
        run_id=run_id,
        parent_run_id=parent_run_id,
        metadata={"pylva_customer_id": "cust_tool", "langgraph_node": "tools"},
    )
    assert len(handler._runs) == 1  # type: ignore[attr-defined]

    handler.on_tool_error(
        RuntimeError("SECRET tool failure details"),
        run_id=run_id,
        parent_run_id=parent_run_id,
    )

    # Run state is reclaimed — no leak on the error path.
    assert len(handler._runs) == 0  # type: ignore[attr-defined]
    assert telemetry.buffer_size() == 1
    event = telemetry._state.buffer[0]  # type: ignore[attr-defined]
    assert event["customer_id"] == "cust_tool"
    assert event["step_name"] == "tools"
    assert event["tool_name"] == "search_tool"
    assert event["status"] == "failure"
    assert event["tokens_in"] == 0
    assert event["tokens_out"] == 0
    assert event["metric"] == "calls"
    assert event["metric_value"] == 1
    assert event["instrumentation_tier"] == "reported"
    assert event["cost_source"] == "configured"
    assert event["metadata"]["error_type"] == "RuntimeError"
    assert event["metadata"]["langgraph_node"] == "tools"
    assert not any("SECRET TOOL INPUT" in str(value) for value in event.values())
    assert not any("SECRET tool failure details" in str(value) for value in event.values())


def test_tool_error_is_a_noop_when_not_tracking_tools() -> None:
    handler = PylvaCallbackHandler(api_key=VALID_KEY, local_mode=True)
    run_id = uuid.uuid4()

    handler.on_tool_error(RuntimeError("boom"), run_id=run_id)

    assert telemetry.buffer_size() == 0
    assert len(handler._runs) == 0  # type: ignore[attr-defined]


def test_chain_error_cleans_run_without_capturing_error() -> None:
    handler = PylvaCallbackHandler(api_key=VALID_KEY, local_mode=True)
    run_id = uuid.uuid4()

    handler.on_chain_start(
        _serialized("LangGraph"),
        {"input": "SECRET CHAIN INPUT"},
        run_id=run_id,
        metadata={"pylva_customer_id": "cust_chain", "langgraph_node": "planner"},
    )
    assert len(handler._runs) == 1  # type: ignore[attr-defined]

    handler.on_chain_error(RuntimeError("SECRET chain failure details"), run_id=run_id)

    # Chains are not billed, but the run must still be reclaimed (no leak).
    assert len(handler._runs) == 0  # type: ignore[attr-defined]
    assert telemetry.buffer_size() == 0


def test_chain_error_flushes_buffered_telemetry_when_requested(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    handler = PylvaCallbackHandler(
        api_key=VALID_KEY,
        local_mode=True,
        flush_on_chain_end=True,
    )
    flushes: list[int] = []

    async def fake_flush() -> None:
        flushes.append(1)

    monkeypatch.setattr(callback_mod, "flush", fake_flush)

    run_id = uuid.uuid4()
    handler.on_chain_start(
        _serialized("LangGraph"),
        {"input": "x"},
        run_id=run_id,
        metadata={"pylva_customer_id": "cust_chain"},
    )
    handler.on_chain_error(RuntimeError("boom"), run_id=run_id)

    assert len(handler._runs) == 0  # type: ignore[attr-defined]
    assert flushes == [1]


@pytest.mark.asyncio
async def test_async_tool_error_cleans_run_and_reports_failure() -> None:
    handler = AsyncPylvaCallbackHandler(api_key=VALID_KEY, local_mode=True, track_tool_calls=True)
    run_id = uuid.uuid4()

    await handler.on_tool_start(
        {"name": "lookup_account"},
        "SECRET TOOL INPUT",
        run_id=run_id,
        metadata={"customer_id": "cust_async_tool", "langgraph_node": "lookup"},
    )
    await handler.on_tool_error(RuntimeError("SECRET async tool failure"), run_id=run_id)

    assert len(handler._runs) == 0  # type: ignore[attr-defined]
    event = telemetry._state.buffer[0]  # type: ignore[attr-defined]
    assert event["status"] == "failure"
    assert event["tool_name"] == "lookup_account"
    assert event["metric_value"] == 1
    assert event["metadata"]["error_type"] == "RuntimeError"
    assert not any("SECRET" in str(value) for value in event.values())


@pytest.mark.asyncio
async def test_async_policy_mode_tracks_approved_tool() -> None:
    handler = AsyncPylvaCallbackHandler(
        api_key=VALID_KEY,
        local_mode=True,
        non_llm={
            "mode": "policy",
            "policy": {
                "sources": [
                    {
                        "slug": "tavily",
                        "status": "tracked",
                        "matchers": ["tavily_search"],
                        "metric": "tavily_requests",
                        "unit": "request",
                        "default_metric_value": 1,
                    }
                ]
            },
        },
    )
    run_id = uuid.uuid4()

    await handler.on_tool_start(
        {"name": "tavily_search"},
        "SECRET TOOL INPUT",
        run_id=run_id,
        metadata={"customer_id": "cust_async_tool", "langgraph_node": "lookup"},
    )
    await handler.on_tool_end("SECRET TOOL OUTPUT", run_id=run_id)

    event = telemetry._state.buffer[0]  # type: ignore[attr-defined]
    assert event["customer_id"] == "cust_async_tool"
    assert event["tool_name"] == "tavily_search"
    assert event["metric"] == "tavily_requests"
    assert event["metric_value"] == 1
    assert not any("SECRET" in str(value) for value in event.values())


def test_callback_fail_open_when_enqueue_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    handler = PylvaCallbackHandler(api_key=VALID_KEY, local_mode=True)
    run_id = uuid.uuid4()

    def boom(_event: dict[str, Any]) -> None:
        raise RuntimeError("enqueue failed")

    monkeypatch.setattr(callback_mod, "enqueue", boom)
    handler.on_llm_start(
        _serialized(),
        ["prompt"],
        run_id=run_id,
        metadata={"customer_id": "cust_1"},
    )
    handler.on_llm_end(_FakeResponse(), run_id=run_id)


@pytest.mark.asyncio
async def test_async_callback_handler_emits_event() -> None:
    handler = AsyncPylvaCallbackHandler(api_key=VALID_KEY, local_mode=True)
    run_id = uuid.uuid4()

    await handler.on_chat_model_start(
        _serialized(),
        [[object()]],
        run_id=run_id,
        metadata={"customer_id": "cust_async", "langgraph_node": "answer"},
    )
    await handler.on_llm_end(
        _FakeResponse(usage_metadata={"input_tokens": 3, "output_tokens": 2}),
        run_id=run_id,
    )

    event = telemetry._state.buffer[0]  # type: ignore[attr-defined]
    assert event["customer_id"] == "cust_async"
    assert event["tokens_in"] == 3
    assert event["tokens_out"] == 2
