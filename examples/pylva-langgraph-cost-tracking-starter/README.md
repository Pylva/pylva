# Pylva LangGraph Cost Tracking Starter

Runnable starter for tracking token cost by LangGraph node and customer.

## Install

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e ../../packages/sdk-py[langchain]
pip install langchain-openai
```

Set runtime keys:

```bash
export PYLVA_API_KEY="pv_live_..."
export OPENAI_API_KEY="sk-..."
```

## Run

```bash
python basic_graph.py
python per_customer_billing.py
python streaming_usage.py
python tool_costs.py
```

Use the callback path for these examples. Do not also wrap the same provider
call with Pylva auto-instrumentation, or the same LLM call may be counted twice.
