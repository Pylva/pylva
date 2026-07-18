# @pylva/sdk (TypeScript)

Cost infrastructure for AI agent businesses. Auto-instruments `openai`,
`@anthropic-ai/sdk`, and Vercel's `ai` clients; emits server-priced telemetry
to your Pylva backend.

Version `1.2.0` adds the explicit authoritative-control client: readiness,
reserve, commit, release, and extend operations with exact-decimal validation,
idempotent caller-owned identities, and a credential-switch barrier across one
physically canonical package-private runtime. Pylva credentials and mutable
enforcement state are never stored on `globalThis`. Public APIs follow SemVer from `1.0.0` onward; the
telemetry wire format remains schema `1.6` and the control wire format is
schema `1.0`.

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

## Authoritative control client (v1.2)

The v1.2 control client is the explicit, low-level API beneath the strict LLM
and non-LLM helpers documented below. You can also call `reserveUsage()` before
a custom provider, then settle a returned reservation with `commitUsage()`,
`releaseUsage()`, or `extendUsage()`.

```ts
import {
  init,
  ready,
  reserveUsage,
  commitUsage,
  releaseUsage,
  PylvaBudgetExceeded,
  PylvaControlUnavailableError,
} from '@pylva/sdk';

init({
  apiKey: process.env.PYLVA_API_KEY!,
  control: {
    mode: 'enforce', // 'legacy' (default) | 'shadow' | 'enforce'
    onUnavailable: 'deny', // 'allow' returns unavailable; 'deny' throws
    timeoutMs: 2_000, // bounded to 100..30,000 ms
  },
});

if (!(await ready())) throw new Error('Pylva control is not ready');

let reservation;
try {
  reservation = await reserveUsage({
    kind: 'llm',
    operationId: crypto.randomUUID(), // reuse this exact id when retrying
    customerId: 'cust_acme',
    traceId: crypto.randomUUID(),
    spanId: crypto.randomUUID(),
    parentSpanId: null,
    provider: 'openai',
    model: 'gpt-4.1',
    estimatedInputTokens: 500,
    maxOutputTokens: 1_000,
  });
} catch (error) {
  if (error instanceof PylvaBudgetExceeded) {
    // source === 'authoritative_control'; exact strings are retained on
    // error.authoritativeDenial.
  }
  if (error instanceof PylvaControlUnavailableError) {
    // The deny policy refused dispatch because control could not decide.
  }
  throw error;
}

if (reservation.decision === 'unavailable') {
  // onUnavailable: 'allow' is honest: allowed remains false. Your application
  // explicitly decides whether to defer, reject, or run without a reservation.
  throw new Error(`control unavailable: ${reservation.controlReason}`);
}

if (reservation.decision === 'bypassed') {
  // Control intentionally did not take ownership (for example, no applicable
  // budget or shadow mode). Dispatch normally; wrapper telemetry remains on.
  await callProvider();
}

if (reservation.decision === 'reserved') {
  let providerStarted = false;
  try {
    providerStarted = true;
    const response = await callProvider();
    await commitUsage({
      reservationId: reservation.reservationId,
      kind: 'llm',
      status: 'success',
      latencyMs: response.latencyMs,
      streamAborted: false,
      actualInputTokens: response.promptTokens,
      actualOutputTokens: response.completionTokens,
    });
  } catch (error) {
    if (!providerStarted) {
      await releaseUsage({
        reservationId: reservation.reservationId,
        reason: 'provider_not_called',
      });
    }
    throw error;
  }
}
```

Important semantics:

- `legacy` is the compatibility default. `reserveUsage()` performs no network
  request and returns a local `bypassed/control_disabled` decision.
- `shadow` and `enforce` first verify server capabilities. Capability reads are
  coalesced and cached for 30 seconds; a 404/405 means an older unsupported
  backend. `ready()` returns a boolean matching the Python SDK;
  `controlStatus()` returns structured diagnostics. Under fail-closed policy,
  transport failure from `ready()` throws `PylvaControlUnavailableError`.
- `onUnavailable: 'allow'` returns a schema-valid `unavailable` decision with
  `allowed: false`. It never fabricates budget approval. `deny` throws
  `PylvaControlUnavailableError` with operation identity and validated evidence.
- An `enforce` denial throws the existing `PylvaBudgetExceeded`, now with
  `source: 'authoritative_control'` and full exact-decimal evidence in
  `authoritativeDenial`. Existing fields and `instanceof` catches remain valid.
- Lifecycle calls always contact the backend, even after switching to `legacy`;
  an existing hold must be settled honestly. Lifecycle unavailability always
  throws instead of pretending commit, release, or extend succeeded.
- A successful authoritative reservation owns the billable telemetry;
  `commitUsage()` settles that reservation with actual usage. Adapter code must call
  `shouldSuppressLegacyTelemetry(reservationResult, { operationId, reservationId })`
  and skip the matching legacy `/events` enqueue only when it returns `true`.
  Pass the schema-valid `reserved` result—not the commit result—so ownership
  survives a lost commit acknowledgement. The proof is bound to the exact IDs
  and current SDK identity; bypassed/unavailable values never own telemetry,
  and the control client itself never enqueues a legacy event.
- Tool decimal bounds/usage accept canonical non-negative decimal strings or
  non-negative safe integers. Responses keep money as exact strings.
- Changing `apiKey` or `endpoint` drops old buffered telemetry with a count-only
  warning, aborts old requests, and clears tenant-owned caches before installing
  the new identity. Reinitializing the same identity retains safe state.

## Strict authoritative LLM wrappers (v1.2)

Use an explicit strict wrapper when a budget denial must stop the provider call
before it can spend money. Import-time auto-instrumentation remains a legacy
telemetry and reactive-budget convenience; it is not the fail-closed authority.

```ts
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { init, wrapOpenAI, wrapAnthropic } from '@pylva/sdk';

init({
  apiKey: process.env.PYLVA_API_KEY!,
  control: { mode: 'enforce', onUnavailable: 'deny' },
});

const openai = await wrapOpenAI(new OpenAI({ apiKey: process.env.OPENAI_API_KEY!, maxRetries: 0 }));
const anthropic = await wrapAnthropic(
  new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY!, maxRetries: 0 }),
);

const openaiResponse = await openai.chat.completions.create({
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'Classify this ticket.' }],
  max_completion_tokens: 200,
});

const anthropicResponse = await anthropic.messages.create({
  model: 'claude-sonnet-4-5',
  messages: [{ role: 'user', content: 'Classify this ticket.' }],
  max_tokens: 200,
});
```

Wrapper initialization is asynchronous so Pylva can load the genuine ESM
provider implementation before it reads provider credentials. It constructs a
new private official client with the canonical provider endpoint, default
transport, and retries disabled; it never dispatches through or re-reads the
caller-owned client after wrapping. The caller client is therefore a validated
configuration carrier, not an execution escape hatch through the returned
controlled facade. Code that separately retains provider credentials and
network access can still create an unwrapped client; see the trust boundary
below.

The returned narrow clients preserve the supported official provider behavior,
including OpenAI `APIPromise` helpers, async streams, and Anthropic's native
`messages.stream()` helper. A provider dispatch occurs only after reserve
succeeds. The strict API does not run the legacy automatic model-routing or
cross-provider failover engine: the supplied provider and model are the final
identity for that attempt. Provider retries are forced off; application
fallback must invoke a separately wrapped provider call so every real attempt
receives a distinct operation identity and a reservation for its actual
provider and model.

The priced v1.2 subset is deliberately narrow:

- OpenAI Chat Completions or Anthropic Messages only.
- Text and client-executed function/tool schemas only; no remote media, hosted
  or server tools, audio, batch/premium tiers, or cache controls.
- Exactly one completion, an explicit positive output-token cap, the exact
  reserved model, and standard/default service tier.
- OpenAI requests require a conservative request bound below 1,024 tokens;
  Anthropic requests require a bound below 200,000 tokens.
- Official endpoints, default transports, and `maxRetries: 0` are required.
  Custom endpoints, fetch functions, default headers, or query overrides are
  refused before provider I/O.
- Compatibility gates cover OpenAI 4.104.0 through the repository-current 5.x
  SDK, plus Anthropic 0.30.1 through the repository-current pre-1.0 SDK.
  Unsupported SDK identities fail before credentials, control I/O, or provider
  I/O.

Unsupported or newly introduced paid dimensions throw
`PylvaStrictProviderError` before dispatch. After dispatch, missing or unsafe
usage, a paid cache/server-tool signal, an exact-model/tier conflict, or a lost
commit acknowledgement never becomes a guessed charge or a release. The
provider result or error keeps its original behavior while the owned
reservation remains unresolved for expiry and reconciliation. Prompts,
messages, tool arguments, URLs, provider responses, and raw provider errors are
never included in control requests or Pylva diagnostics.

Rollout behavior is explicit:

| Control configuration                | Provider dispatch                        | Accounting behavior                                                                        |
| ------------------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------ |
| `legacy`                             | Runs                                     | No control I/O; one legacy telemetry event                                                 |
| `shadow`                             | Runs                                     | Records the honest would-allow/would-deny result when available; one legacy event          |
| `enforce` + `onUnavailable: 'allow'` | Runs on control unavailability           | Reports unavailability honestly; one legacy event                                          |
| `enforce` + `onUnavailable: 'deny'`  | Does not run on denial or unavailability | Fail-closed; a valid reservation owns settlement and suppresses duplicate legacy telemetry |

Only the last row provides the public no-spend-on-control-failure guarantee for
paid paths routed through supported controlled integrations. A definite local
failure after reserve but before provider network dispatch releases the hold.
Any failure after dispatch is ambiguous and is never automatically released.
Stream heartbeats start only when the stream is actively consumed and stop on
EOF, caller/native cancellation, iterator return, error, or facade close; an
idle live stream is also registered with the facade close boundary.

### Trust boundary

The SDK is a cooperative integration boundary, not a hostile same-process
sandbox. It controls supported calls routed through its wrappers and helpers;
it cannot stop application code that possesses a provider credential and
unrestricted provider egress from sending an independent request. If plugins,
tenants, agents, or other application code are adversarial, keep reusable
provider credentials and direct provider egress outside that process. Put
provider dispatch behind a trusted control-plane proxy that owns
reserve/dispatch/settle, with secret and network isolation preventing bypass.

### Vercel AI

The Vercel AI strict helper supports the official OpenAI Chat model on AI SDK
6.x:

```bash
pnpm add @pylva/sdk ai@^6 @ai-sdk/openai@^3
```

```ts
import {
  createControlledOpenAIChatModel,
  controlledGenerateText,
  controlledStreamText,
} from '@pylva/sdk';

const model = await createControlledOpenAIChatModel({
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'gpt-4o-mini',
});

const generated = await controlledGenerateText({
  model,
  prompt: 'Classify this ticket.',
  maxOutputTokens: 200,
  maxRetries: 0,
  providerOptions: { openai: { serviceTier: 'default' } },
});

// Unlike Vercel AI's synchronous streamText(), strict reserve is asynchronous.
const streamed = await controlledStreamText({
  model,
  prompt: 'Classify this ticket.',
  maxOutputTokens: 200,
  maxRetries: 0,
  providerOptions: { openai: { serviceTier: 'default' } },
});
```

The strict helpers accept only the opaque token returned by
`createControlledOpenAIChatModel()`. Pylva constructs and locks the official
`@ai-sdk/openai` 3.x Chat model privately; the returned token is frozen, has no
enumerable fields, and does not expose or serialize the API key or provider
model. Direct official models, copied or forged tokens, structural lookalikes,
custom headers, OpenAI Responses models, and custom transports/endpoints are
refused before a reservation or provider request. AI SDK 6.x and
`@ai-sdk/openai` 3.x are required for this strict path.

The official Vercel Anthropic provider is refused in v1.2 because it does not
preserve the standard-tier request evidence needed for an exact pricing proof;
use `wrapAnthropic()` directly instead.

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
LangChain callback protocol. The deep entrypoint does not patch providers.
Callbacks observe graph/node activity; they do not reserve a budget or turn an
unwrapped provider into an authoritative integration.

For a strict model invocation, combine `llmTracking: 'auto'` with one explicit
control scope around one model call whose implementation dispatches through
`wrapOpenAI()`, `wrapAnthropic()`, or another controlled helper:

```ts
import { init } from '@pylva/sdk';
import { PylvaCallbackHandler, withLangGraphControlScope } from '@pylva/sdk/langgraph';

init({
  apiKey: process.env.PYLVA_API_KEY!,
  control: { mode: 'enforce', onUnavailable: 'deny' },
});

const handler = new PylvaCallbackHandler({ llmTracking: 'auto' });
const response = await withLangGraphControlScope(() =>
  controlledModel.invoke(messages, { callbacks: [handler] }),
);
```

The scope only correlates callback ownership; `controlledModel` must actually
use an explicit Pylva strict wrapper. Use one scope per billable model or
controlled-tool invocation, including each concurrent or batched item. Do not
wrap a whole multi-step graph or agent loop in one scope.

| `llmTracking`    | Behavior                                                                                                                                                                   |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auto` (default) | The exact strict wrapper owns authoritative settlement or rollout fallback; the matching callback does not duplicate billing. An unwrapped model remains callback-tracked. |
| `callback`       | Always use callback-only LLM telemetry; do not combine with a strict wrapper for the same call.                                                                            |
| `off`            | Ignore LLM callbacks while retaining chain and configured tool observation.                                                                                                |

The root and deep TypeScript entrypoints share a private versioned runtime for
identity, tracking context, and exact operation correlation. Callback-first and
provider-first orderings therefore link the same operation and reservation.
Ambiguous zero/multiple matches are never guessed; callback telemetry remains
unsuppressed. A root identity change clears buffered old-tenant state across
the deep bundle before installing the new identity.

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

### Authoritative non-LLM control

Use `controlledUsage()` when the actual quantity is known only after a paid
tool returns. Declare a conservative maximum, keep the provider call inside
`invoke`, and extract the exact billed quantity from its result:

```ts
import { controlledUsage } from '@pylva/sdk';

const result = await controlledUsage({
  costSourceSlug: 'document-ocr',
  toolName: 'Document OCR',
  metric: 'page',
  maximumValue: 20,
  customerId: 'cust_acme',
  invoke: () => ocrClient.process(document),
  extractActual: (response) => response.pagesProcessed,
});

console.log(result.value); // the original provider result
console.log(result.control); // decision, settlement, quantity, and ownership
```

Use `controlledExactUsage()` when the paid quantity is known before dispatch:

```ts
import { controlledExactUsage } from '@pylva/sdk';

await controlledExactUsage({
  costSourceSlug: 'email-delivery',
  toolName: 'Email Delivery',
  metric: 'message',
  value: 1,
  customerId: 'cust_acme',
  invoke: () => emailClient.send(message),
});
```

Both helpers reserve before `invoke` and commit the exact actual quantity. If
the actual value exceeds the declared maximum, the full charge is still
committed and `control.boundViolated` is `true`; it is never truncated to the
hold. A provider error, usage-extraction failure, configuration change, or
commit ambiguity after dispatch never releases or fabricates a charge. In
`enforce` + `deny`, a denial or control failure calls neither the provider nor
the extractor. Legacy, shadow, and allow-on-unavailable fallback retain one
legacy usage event when exact usage can be extracted.

The Tavily adapter pins a price-complete one-credit basic-search contract:

```ts
import { controlledTavilySearch } from '@pylva/sdk';

const search = await controlledTavilySearch(tavilyClient, {
  query: 'authoritative agent budget controls',
  customerId: 'cust_acme',
});
```

It forces basic search, `autoParameters: false`, and `includeUsage: true`.
Advanced, automatic, missing, zero, or fractional credit usage is refused or
left unresolved rather than underpriced. Queries, tool arguments, URLs,
provider results, and raw errors remain local and are never placed in the
control payload or returned control outcome.

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
    console.log(`Source: ${err.source}`); // also 'authoritative_control' for reserveUsage()
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

The bundles remain CI-gated. The v1.2 hardened candidate measures the complete
reachable Pylva runtime for each ESM/CJS public entrypoint, counting every
physical package-private module once:

| Target               | Current bytes | Fixed limit |
| -------------------- | ------------: | ----------: |
| `core`               |        49,045 |      49,700 |
| `openai` wrapper     |        25,367 |      25,900 |
| `anthropic` wrapper  |        25,392 |      25,900 |
| `vercel-ai` wrapper  |        20,184 |      21,000 |
| `langgraph` callback |        15,051 |      15,700 |

The root closure includes the authenticated control transport, strict provider
integrations, descriptor-safe snapshots, exact non-LLM control, Tavily,
ownership correlation, embedded source maps, and cache-tamper hardening. Root,
deep, ESM, and CJS entrypoints converge through package-private mappings on one
physical closure-owned runtime per stateful domain; they do not expose Pylva
state through process-global symbols. Bundle splitting remains rejected because
it made the complete closures larger and conflicted with `sideEffects: false`.

The fixed limits were rebaselined once from the hardened candidate with 4%
release headroom rounded to 100 bytes. CI stores these constants and never
computes a new limit from the build being tested. Any future increase requires
an explicit decision record; validation, privacy, provider behavior, source
maps, and cache hardening cannot be removed merely to satisfy this performance
gate.

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
