from __future__ import annotations

import os

from langchain.chat_models import init_chat_model
from langchain_core.tools import tool
from langgraph.prebuilt import create_react_agent
from pylva.langchain import PylvaCallbackHandler


@tool
def lookup_account_status(account_id: str) -> str:
    """Look up account status for a demo account id."""
    return f"{account_id} is active"


model = init_chat_model("openai:gpt-4o-mini")
agent = create_react_agent(model, tools=[lookup_account_status])

handler = PylvaCallbackHandler(
    api_key=os.environ["PYLVA_API_KEY"],
    track_tool_calls=True,
)

agent.invoke(
    {"messages": [{"role": "user", "content": "Check account acct_demo."}]},
    config={
        "callbacks": [handler],
        "metadata": {"pylva_customer_id": "cust_tool_demo"},
    },
)
