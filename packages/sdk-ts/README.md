# @pylva/sdk (TypeScript)

Cost infrastructure for AI agent businesses. Auto-instruments `openai`,
`@anthropic-ai/sdk`, and Vercel's `ai` clients; emits server-priced telemetry
to your Pylva backend.

Version `1.1.0` strengthens budget enforcement: ALL matching budget rules
are enforced per call (a customer's own cap is never shadowed by a global
rule), completed calls are priced locally so hard stops engage in-process
without waiting for a backend round-trip, untracked traffic is enforced
under the same `anonymous` identity it is billed to, and `track()` warns on
customer ids the backend would reject. Public APIs follow SemVer from
`1.0.0` onward; the telemetry wire format remains schema `1.6`.

```bash
pnpm add @pylva/sdk
```

```ts
import { init } from '@pylva/sdk';

init({
  apiKey: 'pv_live_...',
  endpoint: 'https://api.pylva.com', // optional; omit to use the default
});
// every subsequent openai / anthropic / ai call emits a telemetry event.
```

Any Pylva API key works — one key covers telemetry, rules, pricing, budget sync, and data import (legacy `pv_cli_...` keys included).

### Failover (reliability_failover rules)

If you use `reliability_failover` rules, switch to the explicit-client
constructor so Pylva has a handle to the backup provider:

```ts
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { Pylva } from '@pylva/sdk';

new Pylva({
  apiKey: 'pv_live_...',
  openai: new OpenAI(),
  anthropic: new Anthropic(),
});
```

`init({ apiKey })` keeps working for telemetry-only deployments. In v1.0,
the SDK detects active cross-provider failover states and surfaces warnings;
actual backup-provider dispatch is still beta/internal and is not part of
the stable launch promise.

## Auto-instrumentation

Importing `@pylva/sdk` patches any `openai`, `@anthropic-ai/sdk`, or
`ai` packages already loaded in the host process. The patches are isolated
per R1 — any SDK error is swallowed so your agent keeps running.

Calls are captured with: `model`, `provider`, `tokens_in`, `tokens_out`,
`latency_ms`, `status`, `step_name` (if set), `customer_id`. Cost is computed
server-side against your builder's pricing tables.

## Tracking context

```ts
import { track } from '@pylva/sdk';

await track('acme-corp', { step: 'authentication' }, async () => {
  // every LLM call inside this scope carries the metadata
  const res = await openai.chat.completions.create(/* ... */);
  return res;
});
```

`track` uses `AsyncLocalStorage` so the context propagates correctly across
awaits without you threading it manually.

## LangGraph / LangChain callbacks

For LangGraph.js or LangChain.js graphs, use the callback entrypoint instead of
the root auto-instrumentation entrypoint:

```bash
pnpm add @pylva/sdk @langchain/core @langchain/langgraph
```

```ts
import { PylvaCallbackHandler } from '@pylva/sdk/langgraph';

const handler = new PylvaCallbackHandler({
  apiKey: process.env.PYLVA_API_KEY!,
});

await graph.invoke(input, {
  callbacks: [handler],
  metadata: { pylva_customer_id: 'cust_acme' },
});
```

`@pylva/sdk/langchain` re-exports the same handler for users searching by the
LangChain callback protocol. The deep entrypoint does not import the root SDK
or patch provider clients, so callback attribution does not double-count model
calls. Use either this callback path or provider auto-instrumentation for the
same runtime.

The callback records LangGraph run ids, parent run ids, node attribution,
provider, model, token usage, latency, status, and customer id. It never sends
prompts, completions, tool inputs, or tool outputs. Customer resolution order is
constructor `customerId`, `metadata.pylva_customer_id`, `metadata.customer_id`,
active `track()` context, then `anonymous`.
Metadata step labels from `langgraph_node`, `langgraph_step`, and `pylva_step`
must be identifier-like (`[A-Za-z0-9_.:/-]`, max 100 chars). Free-text prompts
or messages should never be placed in metadata; unsafe labels are ignored.

Tool-call observation is policy-driven. In production, let the dashboard decide
which non-LLM tools are billable:

```ts
const handler = new PylvaCallbackHandler({
  apiKey: process.env.PYLVA_API_KEY!,
  nonLlm: {
    mode: 'policy',
    usageExtractors: {
      // Optional. If omitted, the dashboard source's default usage value is used.
      tavily: (ctx) => {
        const output = ctx.output as { results?: unknown[] } | undefined;
        return output?.results?.length ?? 1;
      },
    },
  },
});
```

Policy mode fetches `/api/v1/sdk/non-llm-policy`, tracks only dashboard-approved
sources, ignores dashboard-ignored sources, and sends unknown tools to
`/api/v1/sdk/non-llm-discoveries` as pending candidates. Unknown and pending
tools never affect customer cost. Tool inputs, outputs, prompts, messages, and
raw errors are never sent to Pylva.

`trackToolCalls: true` is still supported for legacy users, but it records every
tool as `metric="calls"` with `metric_value=1` and logs a warning. Prefer
`nonLlm: { mode: 'policy' }` so builders explicitly approve and price each
non-LLM cost source in the dashboard.

## Non-LLM costs

For manual reporting outside LangGraph/LangChain callbacks:

```ts
import { reportUsage } from '@pylva/sdk';

reportUsage({
  customer_id: 'acme-corp',
  tool: 'translation',
  metric: 'characters',
  value: 4_200,
  step: 'translation',
});
```

For discovered callback tools, the dashboard flow is:

1. A tool runs in policy mode and is not recognized.
2. The SDK sends a discovery candidate with a normalized matcher only.
3. The builder opens Cost Sources, then chooses Track or Ignore.
4. Tracking requires a display name, metric, unit, matcher, and price.
5. Future SDK calls matching that policy emit `reported` non-LLM cost events.

## Reactive budget enforcement (B2a)

When a builder has a `budget_limit` rule configured with `hard_stop: true`,
the SDK enforces **pre-call**:

```ts
import { init, PylvaBudgetExceeded } from '@pylva/sdk';

init({ apiKey: 'pv_live_...' });

try {
  await openai.chat.completions.create({
    /* ... */
  });
} catch (err) {
  if (err instanceof PylvaBudgetExceeded) {
    console.log(`Budget hit for ${err.customer_id}: $${err.accumulated_usd} / $${err.limit_usd}`);
    console.log(`Source: ${err.source}`); // 'sdk_precall' | 'backend_ingest_flag'
    // graceful degradation: return a cached response, queue the request, etc.
  } else {
    throw err;
  }
}
```

### How it works

1. **Every matching rule is enforced.** A call is checked against ALL
   applicable `budget_limit` rules — a customer-specific cap AND any
   global cap both apply (strictest wins), matching the server's own
   `budget_exceeded` semantics. Untracked calls (outside `pylva.track()`)
   are enforced under the `anonymous` identity, the same identity their
   telemetry is billed to.

2. **Pre-call (local, fail-open).** The SDK maintains a per-process
   accumulator keyed on `(rule_id, customer_id, period_start)`. Completed
   LLM calls are priced from the local pricing cache at enqueue time and
   recorded against every applicable rule's accumulator, so a `hard_stop`
   engages on the very next call — no backend round-trip required. If the
   local view is already over a `hard_stop` limit, the SDK throws
   `PylvaBudgetExceeded{ source: 'sdk_precall' }` and the LLM provider is
   never called. The exact-limit boundary blocks (`>=`, matching the
   server).

3. **Backend-authoritative (cross-container safety).** Every ingest response
   carries `budget_exceeded[]` computed from ClickHouse. On receipt the
   SDK bumps local accumulators to `limit + 1` so the **next** pre-call for
   that key throws `PylvaBudgetExceeded{ source: 'backend_ingest_flag' }`.
   This bounds cross-container overshoot after the backend has observed the
   exceedance.

4. **5-min reconciliation.** The SDK POSTs its accumulator to
   `/api/v1/budget/sync` every 5 minutes. The server replies with the
   authoritative total; local accumulators are overwritten (not added).

5. **Passthrough mode.** If the rules cache is cold OR the backend is
   unreachable, pre-call enforcement is a no-op. Your agent never blocks
   because Pylva is degraded — see R5.

### Rule enforcement matrix

| `type`           | `hard_stop` | Behavior                                                                |
| ---------------- | ----------- | ----------------------------------------------------------------------- |
| `budget_limit`   | `true`      | Pre-call throws `PylvaBudgetExceeded`. LLM call is skipped.             |
| `budget_limit`   | `false`     | Pre-call emits an advisory warning (1/min per rule). LLM call proceeds. |
| `cost_threshold` | n/a         | Post-call evaluation only; no SDK-side enforcement.                     |

## Webhook verification

For rule-fire webhooks:

```ts
import { verifyWebhook } from '@pylva/sdk';

app.post('/pylva-webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const body = req.body.toString('utf8');
  const sig = req.header('X-Pylva-Signature') ?? '';
  const ts = req.header('X-Pylva-Timestamp') ?? '';
  const ok = verifyWebhook(body, sig, process.env.WEBHOOK_SECRET!, ts);
  if (!ok) return res.status(400).send('invalid signature');
  // ...
});
```

`verifyWebhook` accepts both raw hex and the `sha256=<hex>` GitHub-style
prefix (B2a D34). The timestamp tolerance is 300 s by default.

## Privacy & PII

Pylva **does not redact** `step_name`, `customer_id`, or `metadata`
values. Do **not** pass raw user message content, email addresses, or phone
numbers into these fields. LangGraph metadata step labels are accepted only
when they are identifier-like; other validation rejects HTML and most control
characters, but it does not protect against free-form PII.

SDKs never auto-redact by design: regex redaction is noisy and incomplete, and
classifier redaction would add an LLM round-trip to the hot path. PII handling
is the builder's responsibility; we provide exportable data and deletion
endpoints.

## Bundle size budget

The core bundle is capped at **20 KB gzipped** (CI-gated). As of B2a:

| Target               | Size               |
| -------------------- | ------------------ |
| `core` (index.js)    | 7.73 KB            |
| `openai` wrapper     | 3.85 KB            |
| `anthropic` wrapper  | 3.83 KB            |
| `vercel-ai` wrapper  | 3.69 KB            |
| `langgraph` callback | CI-capped at 15 KB |

## Passthrough & fail-modes

- **Rules cache expired + backend unreachable.** Pre-call enforcement becomes
  a no-op; LLM call proceeds. Log once per 5-min window.
- **Ingest degraded (401 / 403).** SDK enters `degraded` state: buffer is
  dropped, subsequent events are no-ops. A loud console message points at
  the key. No silent data loss.
- **Telemetry buffer full (10K cap).** Oldest events dropped with a warning.
  Set `batchSize` + `flushInterval` in `init()` to tune.

## License

MIT.
