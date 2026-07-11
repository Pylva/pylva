# Pylva LangGraph.js Cost Tracking Starter

Runnable TypeScript starter for tracking token cost by LangGraph node and
customer.

## Install

```bash
pnpm add @pylva/sdk @langchain/langgraph @langchain/openai
pnpm add -D tsx typescript @types/node
```

Set runtime keys:

```bash
export PYLVA_API_KEY="pv_live_..."
export OPENAI_API_KEY="sk-..."
```

## Run

```bash
pnpm tsx basic_graph.ts
```

Use the callback path for this example. Do not also import the root
`@pylva/sdk` package for the same provider calls, or the same LLM call may be
counted twice.
