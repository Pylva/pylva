"""Real LangGraph StateGraph callback ownership journeys.

This module is skipped when the optional ``langchain`` extra is not installed;
release CI installs that extra and executes the journeys against LangGraph 1.x.
"""

from __future__ import annotations

import asyncio
import uuid
from typing import Any

import pytest
from typing_extensions import TypedDict

pytest.importorskip("langgraph")

from langchain_core.language_models.fake_chat_models import FakeListChatModel  # noqa: E402
from langchain_core.messages import HumanMessage  # noqa: E402
from langchain_core.runnables import RunnableConfig  # noqa: E402
from langgraph.graph import END, START, StateGraph  # noqa: E402

from pylva.core import telemetry  # noqa: E402
from pylva.core.config import get_config_generation  # noqa: E402
from pylva.core.control_ownership import (  # noqa: E402
    ControlledAttemptContext,
    _controlled_attempt_scope,
)
from pylva.langchain import PylvaCallbackHandler, langgraph_control_scope  # noqa: E402


class _State(TypedDict):
    value: str


class _ControlledFakeListChatModel(FakeListChatModel):
    """Faithful order: callback start, then provider dispatch correlation."""

    attempt: ControlledAttemptContext

    def _call(self, *args: Any, **kwargs: Any) -> str:
        with _controlled_attempt_scope(self.attempt):
            return super()._call(*args, **kwargs)


def setup_function(_fn: object) -> None:
    telemetry._reset_telemetry_for_tests()  # type: ignore[attr-defined]


def _attempt() -> ControlledAttemptContext:
    return ControlledAttemptContext(
        kind="llm",
        operation_id=str(uuid.uuid4()),
        reservation_id=str(uuid.uuid4()),
        trace_id=str(uuid.uuid4()),
        span_id=str(uuid.uuid4()),
        parent_span_id=None,
        customer_id="customer_acme",
        provider="openai",
        model="gpt-4o-mini",
        owns_reservation=True,
        legacy_telemetry_required=False,
        config_generation=get_config_generation(),
    )


def _graph(*, controlled: bool) -> Any:
    model: FakeListChatModel = (
        _ControlledFakeListChatModel(responses=["ok"], attempt=_attempt())
        if controlled
        else FakeListChatModel(responses=["ok"])
    )

    def call_model(state: _State, config: RunnableConfig) -> dict[str, str]:
        if controlled:
            with langgraph_control_scope():
                reply = model.invoke([HumanMessage(state["value"])], config=config)
        else:
            reply = model.invoke([HumanMessage(state["value"])], config=config)
        return {"value": str(reply.content)}

    return (
        StateGraph(_State)
        .add_node("call_model", call_model)
        .add_edge(START, "call_model")
        .add_edge("call_model", END)
        .compile()
    )


def test_real_stategraph_auto_keeps_exact_wrapper_as_only_billable_owner() -> None:
    handler = PylvaCallbackHandler()

    result = _graph(controlled=True).invoke(
        {"value": "hello"},
        {
            "callbacks": [handler],
            "metadata": {"pylva_customer_id": "customer_acme"},
        },
    )

    assert result["value"] == "ok"
    assert telemetry.buffer_size() == 0


def test_real_stategraph_callback_only_records_one_node_attributed_event() -> None:
    handler = PylvaCallbackHandler(llm_tracking="callback")

    result = _graph(controlled=False).invoke(
        {"value": "hello"},
        {
            "callbacks": [handler],
            "metadata": {"pylva_customer_id": "customer_acme"},
        },
    )

    assert result["value"] == "ok"
    assert telemetry.buffer_size() == 1
    event = telemetry._state.buffer[0]  # type: ignore[attr-defined]
    assert event["customer_id"] == "customer_acme"
    assert event["step_name"] == "call_model"
    assert event["framework"] == "langgraph"


def test_real_stategraph_concurrent_identical_metadata_uses_separate_scopes() -> None:
    handler = PylvaCallbackHandler()
    models = [
        _ControlledFakeListChatModel(responses=["ok"], attempt=_attempt()),
        _ControlledFakeListChatModel(responses=["ok"], attempt=_attempt()),
    ]

    async def call_model(_state: _State, config: RunnableConfig) -> dict[str, str]:
        async def invoke(model: _ControlledFakeListChatModel) -> str:
            with langgraph_control_scope():
                reply = await model.ainvoke([HumanMessage("same")], config=config)
            return str(reply.content)

        replies = await asyncio.gather(*(invoke(model) for model in models))
        return {"value": ",".join(replies)}

    graph = (
        StateGraph(_State)
        .add_node("call_model", call_model)
        .add_edge(START, "call_model")
        .add_edge("call_model", END)
        .compile()
    )

    result = asyncio.run(
        graph.ainvoke(
            {"value": "hello"},
            {
                "callbacks": [handler],
                "metadata": {"pylva_customer_id": "customer_acme"},
            },
        )
    )

    assert result["value"] == "ok,ok"
    assert telemetry.buffer_size() == 0
