from __future__ import annotations

import os
from typing_extensions import TypedDict

from langchain.chat_models import init_chat_model
from langchain_core.messages import HumanMessage
from langgraph.graph import END, START, StateGraph
from pylva.langchain import PylvaCallbackHandler


class State(TypedDict):
    question: str
    answer: str


model = init_chat_model("openai:gpt-4o-mini")


def answer(state: State) -> dict[str, str]:
    response = model.invoke([HumanMessage(content=state["question"])])
    return {"answer": str(response.content)}


graph = (
    StateGraph(State)
    .add_node("answer", answer)
    .add_edge(START, "answer")
    .add_edge("answer", END)
    .compile()
)

handler = PylvaCallbackHandler(api_key=os.environ["PYLVA_API_KEY"])

for update in graph.stream(
    {"question": "Explain why raw usage should be priced server-side."},
    stream_mode="updates",
    config={
        "callbacks": [handler],
        "metadata": {"pylva_customer_id": "cust_streaming_demo"},
    },
):
    print(update)
