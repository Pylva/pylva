# Pylva Coding Agent Guide

This file is the public-repo guide for AI coding agents working in Pylva.

## 0. Start Here

Before editing, read:

- `README.md` for product positioning, cloud quickstart, self-hosting, licensing, telemetry, and community links.
- `CONTRIBUTING.md` for local setup, test commands, PR flow, and CLA expectations.
- Existing UI components and `src/app/globals.css` before changing user-facing UI. Deeper product docs live at <https://docs.pylva.com>.
- Data tables must be composed from the shared primitives in `src/components/ui/table.tsx` (never hand-roll `<table>` markup — enforced by ESLint and `tests/dashboard/table-primitive-usage.test.ts`).

## Code Rules

- TypeScript is strict. Do not use `any` unless there is a short justification comment explaining why the type boundary cannot be narrower.
- This repo is ESM. Relative TypeScript imports that compile to runtime JavaScript must include `.js` extensions.
- Read environment values only through the validated config module. Never read raw `process.env` in app code.
- SDK wrappers must never throw Pylva instrumentation failures into the host agent. Cost tracking should fail open unless the host explicitly opts into a blocking rule.
- Do not send prompts, completions, tool arguments, message bodies, API keys, or secrets in telemetry.
- DNS, Undici dispatcher, and outbound-network changes require a real-socket integration test. Mocked `fetch` or DNS tests alone are not sufficient.
- Keep changes scoped to the requested behavior. Avoid unrelated rewrites and formatting churn.
- No new dependencies without maintainer agreement.

## Commands

| Task | Command |
|---|---|
| Install dependencies | `pnpm install` |
| Start local services | `docker compose -f docker/docker-compose.yml up -d` |
| Run migrations | `pnpm db:setup` |
| Seed local data | `pnpm db:seed` |
| Start dev server | `pnpm dev` |
| Typecheck | `pnpm typecheck` |
| Lint | `pnpm lint` |
| Unit tests | `pnpm test` |
| Integration tests | `pnpm test:integration` |
| External egress socket test | `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/external-egress-transport.test.ts` |
| Live provider egress check | `pnpm check:external-egress` |
| E2E tests | `pnpm test:e2e` |
| Validate cost sources | `pnpm exec pylva validate` |
| Validate cost sources in CI mode | `pnpm exec pylva validate --ci` |

## SDK Usage

Use the published SDK package names from this public repo:

| Runtime | Install | Import package |
|---|---|---|
| Python | `pip install pylva-sdk` | `pylva` |
| TypeScript | `npm i @pylva/sdk` | `@pylva/sdk` |

For Python LangGraph or LangChain callbacks, install the extra and import the callback handler:

```python
# pip install "pylva-sdk[langchain]"
import os
import pylva
from pylva.langchain import PylvaCallbackHandler

pylva.init(api_key=os.environ["PYLVA_API_KEY"])
handler = PylvaCallbackHandler(api_key=os.environ["PYLVA_API_KEY"])

with pylva.track_context(customer_id="cust_acme", step="summarize"):
    pass
```

To let Pylva discover non-LLM tool calls without billing every tool by default,
enable dashboard policy mode:

```python
handler = PylvaCallbackHandler(
    api_key=os.environ["PYLVA_API_KEY"],
    non_llm={"mode": "policy"},
)
```

Unknown tools appear as pending Cost Sources. Builders choose which sources to
track or ignore, then set matchers, metrics, units, and pricing in the
dashboard. The Python SDK uses that same policy on future runs.

For TypeScript LangGraph callbacks, install the SDK alongside LangGraph packages:

```ts
// npm i @pylva/sdk @langchain/core @langchain/langgraph
import { PylvaCallbackHandler } from '@pylva/sdk/langgraph';

const handler = new PylvaCallbackHandler({
  apiKey: process.env.PYLVA_API_KEY!,
  customerId: 'cust_acme',
});
```

## Telemetry Validation Limits

Apply these limits when writing telemetry ingest or SDK code:

| Field | Max Length | Allowed Chars |
|---|---:|---|
| step_name | 200 | alphanumeric + space/underscore/hyphen/dot/colon/slash |
| model | 255 | any non-blank, non-control-character string |
| provider | 255 | any non-blank, non-control-character string |
| tool_name | 200 | same as step_name |
| metadata | 4KB | valid JSON |
| customer_id | 255 | alphanumeric + underscore/hyphen |
| trace_id/span_id | - | UUID v4 |

## Public Support And Security

- Community support happens in the Pylva Slack community.
- Public bugs and feature requests belong in GitHub issues.
- Vulnerabilities must be reported privately through the repository Security tab or tools@pylva.com.
