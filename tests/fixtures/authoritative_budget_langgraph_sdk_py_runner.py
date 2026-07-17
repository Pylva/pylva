"""Packed Python SDK + real StateGraph authoritative-control journey."""

from __future__ import annotations

import json
import os
import re
import sys
from contextlib import redirect_stdout
from pathlib import Path
from typing import Any

import httpx
import openai
import respx
from langchain_core.language_models.fake_chat_models import FakeListChatModel
from langchain_core.messages import HumanMessage
from langchain_core.runnables import RunnableConfig
from langchain_core.tools import StructuredTool
from langgraph.graph import END, START, StateGraph
from typing_extensions import TypedDict

import pylva
from pylva.core import telemetry
from pylva.core.control_ownership import current_controlled_attempt
from pylva.errors.budget_exceeded import PylvaBudgetExceeded
from pylva.langchain import PylvaCallbackHandler, langgraph_control_scope

MODEL = "gpt-langgraph-e2e"
TOOL_SLUG = "langgraph-e2e-tool"
TOOL_NAME = "langgraph_e2e_tool"
TOOL_METRIC = "calls"
SDK_PATH = Path(pylva.__file__ or "").resolve().as_posix()
OPENAI_PATH = Path(openai.__file__ or "").resolve().as_posix()


class _State(TypedDict):
    value: str


def _write(value: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(value, separators=(",", ":"), sort_keys=True) + "\n")
    sys.stdout.flush()


def _attempt_ids(kind: str) -> dict[str, str]:
    attempt = current_controlled_attempt()
    if attempt is None or attempt.kind != kind or attempt.reservation_id is None:
        raise RuntimeError(f"missing controlled {kind} attempt")
    return {
        "operation_id": attempt.operation_id,
        "reservation_id": attempt.reservation_id,
    }


class _Journey:
    def __init__(self, customer_id: str) -> None:
        self.customer_id = customer_id
        self.provider_calls = 0
        self.tool_calls = 0
        self.allowed_llm: dict[str, str] | None = None
        self.allowed_tool: dict[str, str] | None = None
        self.telemetry_before_refusal: int | None = None
        native = openai.OpenAI(api_key="provider-private-langgraph-key", max_retries=0)
        self._openai = pylva.wrap_openai(native)
        native.close()
        self.model = _ControlledChatModel(responses=[], journey=self)
        self.tool = StructuredTool.from_function(
            func=self.call_tool,
            name=TOOL_NAME,
            description="One deterministic priced integration-test tool call.",
        )

    def call_llm(self) -> None:
        self._openai.chat.completions.create(
            model=MODEL,
            messages=[{"role": "user", "content": "integration"}],
            max_completion_tokens=8,
        )

    def provider_response(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        if (
            body.get("model") != MODEL
            or body.get("max_completion_tokens") != 8
            or not isinstance(body.get("messages"), list)
        ):
            raise RuntimeError(
                "official OpenAI request lost the controlled LangGraph shape"
            )
        self.provider_calls += 1
        self.allowed_llm = _attempt_ids("llm")
        return httpx.Response(
            200,
            request=request,
            headers={"x-request-id": "req_python_langgraph_e2e"},
            json={
                "id": "chatcmpl_python_langgraph_e2e",
                "object": "chat.completion",
                "created": 1_784_009_600,
                "model": MODEL,
                "service_tier": "default",
                "choices": [
                    {
                        "index": 0,
                        "message": {
                            "role": "assistant",
                            "content": "llm-ok",
                            "refusal": None,
                        },
                        "finish_reason": "stop",
                        "logprobs": None,
                    }
                ],
                "usage": {
                    "prompt_tokens": 2,
                    "completion_tokens": 3,
                    "total_tokens": 5,
                    "prompt_tokens_details": {"cached_tokens": 0},
                },
            },
        )

    def close(self) -> None:
        self._openai.close()

    def _invoke_tool(self) -> str:
        self.tool_calls += 1
        if self.allowed_tool is None:
            self.allowed_tool = _attempt_ids("tool")
        return "tool-ok"

    def call_tool(self) -> str:
        result = pylva.controlled_exact_usage_sync(
            cost_source_slug=TOOL_SLUG,
            tool_name=TOOL_NAME,
            metric=TOOL_METRIC,
            value=1,
            customer_id=self.customer_id,
            invoke=self._invoke_tool,
        )
        return result.value


class _ControlledChatModel(FakeListChatModel):
    journey: _Journey

    def _call(self, *_args: Any, **_kwargs: Any) -> str:
        self.journey.call_llm()
        return "llm-ok"


def _graph(journey: _Journey) -> Any:
    def allowed_llm(state: _State, config: RunnableConfig) -> dict[str, str]:
        with (
            pylva.track_context(
                journey.customer_id,
                step="langgraph.allowed_llm",
                framework="langgraph",
            ),
            langgraph_control_scope(),
        ):
            reply = journey.model.invoke([HumanMessage(state["value"])], config=config)
        return {"value": str(reply.content)}

    def allowed_tool(_state: _State, config: RunnableConfig) -> dict[str, str]:
        with (
            pylva.track_context(
                journey.customer_id,
                step="langgraph.allowed_tool",
                framework="langgraph",
            ),
            langgraph_control_scope(),
        ):
            value = journey.tool.invoke({}, config=config)
        return {"value": str(value)}

    def refused_tool(_state: _State, config: RunnableConfig) -> dict[str, str]:
        journey.telemetry_before_refusal = telemetry.buffer_size()
        with (
            pylva.track_context(
                journey.customer_id,
                step="langgraph.refused_tool",
                framework="langgraph",
            ),
            langgraph_control_scope(),
        ):
            value = journey.tool.invoke({}, config=config)
        return {"value": str(value)}

    return (
        StateGraph(_State)
        .add_node("langgraph.allowed_llm", allowed_llm)
        .add_node("langgraph.allowed_tool", allowed_tool)
        .add_node("langgraph.refused_tool", refused_tool)
        .add_edge(START, "langgraph.allowed_llm")
        .add_edge("langgraph.allowed_llm", "langgraph.allowed_tool")
        .add_edge("langgraph.allowed_tool", "langgraph.refused_tool")
        .add_edge("langgraph.refused_tool", END)
        .compile()
    )


def main() -> None:
    endpoint = os.environ.get("PYLVA_LANGGRAPH_ENDPOINT")
    api_key = os.environ.get("PYLVA_LANGGRAPH_API_KEY")
    customer_id = os.environ.get("PYLVA_LANGGRAPH_CUSTOMER_ID")
    refusal_kind = os.environ.get("PYLVA_LANGGRAPH_REFUSAL_KIND", "tool")
    if (
        endpoint is None
        or api_key is None
        or customer_id is None
        or refusal_kind != "tool"
    ):
        raise RuntimeError("invalid Python LangGraph runner configuration")

    pylva.init(
        api_key,
        endpoint=endpoint,
        control={"mode": "enforce", "on_unavailable": "deny", "timeout_ms": 30_000},
    )
    if not pylva.ready_sync():
        raise RuntimeError("Python LangGraph control did not become ready")

    # track_tool_calls emits a one-time migration notice. Keep stdout reserved
    # for the single machine-readable result line consumed by the TS harness.
    with redirect_stdout(sys.stderr):
        handler = PylvaCallbackHandler(
            customer_id=customer_id,
            llm_tracking="auto",
            track_tool_calls=True,
        )
    journey = _Journey(customer_id)
    graph = _graph(journey)
    provider_route: respx.Route | None = None
    try:
        with respx.mock(assert_all_called=False) as router:
            router.route(
                url__regex=re.compile(rf"^{re.escape(endpoint.rstrip('/'))}(?:/|$)")
            ).pass_through()
            provider_route = router.post(
                "https://api.openai.com/v1/chat/completions"
            ).mock(side_effect=journey.provider_response)
            with pylva.track_context(customer_id, framework="langgraph") as trace:
                try:
                    graph.invoke(
                        {"value": "start"},
                        {
                            "callbacks": [handler],
                            "metadata": {"pylva_customer_id": customer_id},
                        },
                    )
                except PylvaBudgetExceeded as error:
                    refusal = error.authoritative_denial
                    if refusal is None:
                        raise RuntimeError(
                            "refusal lacks authoritative decision evidence"
                        ) from error
                    refusal_rule_id = error.rule_id
                else:
                    raise RuntimeError(
                        "expected the final paid tool node to be refused"
                    )
    finally:
        journey.close()

    if provider_route is None or provider_route.call_count != 1:
        raise RuntimeError(
            "official OpenAI provider route did not dispatch exactly once"
        )

    if journey.allowed_llm is None or journey.allowed_tool is None:
        raise RuntimeError(
            "allowed graph nodes did not expose controlled attempt identities"
        )
    if journey.telemetry_before_refusal is None:
        raise RuntimeError("refusal node did not execute")

    _write(
        {
            "event": "result",
            "runtime": "python",
            "sdk_path": SDK_PATH,
            "sdk_version": pylva.__version__,
            "openai_path": OPENAI_PATH,
            "openai_version": openai.__version__,
            "customer_id": customer_id,
            "trace_id": trace.trace_id,
            "provider_calls": journey.provider_calls,
            "tool_calls": journey.tool_calls,
            "telemetry_before_refusal": journey.telemetry_before_refusal,
            "telemetry_after_refusal": telemetry.buffer_size(),
            "allowed_llm": journey.allowed_llm,
            "allowed_tool": journey.allowed_tool,
            "refusal": {
                "kind": refusal_kind,
                "operation_id": refusal.operation_id,
                "decision_id": refusal.decision_id,
                "rule_id": refusal_rule_id,
                "provider_calls_after": journey.provider_calls,
                "tool_calls_after": journey.tool_calls,
            },
        }
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001 - fixture must surface every failure
        _write(
            {
                "event": "error",
                "runtime": "python",
                "name": type(error).__name__,
                "message": str(error),
            }
        )
        raise
