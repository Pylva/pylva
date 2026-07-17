# pylva (Python)

Cost infrastructure for AI agent businesses. Auto-instruments `openai` and
`anthropic` clients; emits server-priced telemetry to your Pylva backend.

Version `1.2.0` adds opt-in authoritative budget reservation APIs and strengthens
budget enforcement: ALL matching budget rules
are enforced per call (a customer's own cap is never shadowed by a global
rule), completed calls are priced locally so hard stops engage in-process
without waiting for a backend round-trip, untracked traffic is enforced
under the same `anonymous` identity it is billed to, and `track()` warns on
customer ids the backend would reject. Public APIs follow SemVer; the
telemetry wire format remains schema `1.6`.

```bash
pip install pylva-sdk
```

```python
import pylva

pylva.init(api_key="pv_live_...", endpoint="https://api.pylva.com")
# every subsequent openai / anthropic call emits a telemetry event.
```

Any Pylva API key works — one key covers telemetry, rules, pricing, budget sync, and data import (legacy `pv_cli_...` keys included).

## Authoritative budget reservations (opt in)

SDK 1.x remains backward compatible: `control.mode` defaults to `legacy`, so
existing applications do not make reservation requests. Enable authoritative
control explicitly:

```python
import pylva

pylva.init(
    api_key="pv_live_...",
    control={
        "mode": "enforce",          # legacy | shadow | enforce
        "on_unavailable": "deny",  # allow | deny
        "timeout_ms": 2_000,
    },
)

if not pylva.ready_sync():
    raise RuntimeError("Pylva authoritative control is not enabled")

decision = pylva.reserve_usage_sync(
    {
        "kind": "llm",
        "operation_id": "11111111-1111-4111-8111-111111111111",
        "customer_id": "acme-corp",
        "trace_id": "22222222-2222-4222-8222-222222222222",
        "span_id": "33333333-3333-4333-8333-333333333333",
        "parent_span_id": None,
        "step_name": "answer",
        "provider": "openai",
        "model": "gpt-4o-mini",
        "estimated_input_tokens": 100,
        "max_output_tokens": 300,
    }
)
```

`ready_sync()` and `await ready()` always return a boolean for a clean
supported-and-enabled check. A denied reservation raises the existing
`PylvaBudgetExceeded`, with its legacy numeric fields plus exact validated
denial evidence in `authoritative_denial`. With `on_unavailable="deny"`,
transport or malformed-response failures raise
`PylvaControlUnavailableError`. With `"allow"`, reserve returns an honest
`unavailable` decision (`allowed=False`); it never fabricates approval.

Async and true-sync lifecycle APIs are both available:

- `reserve_usage()` / `reserve_usage_sync()`
- `commit_usage()` / `commit_usage_sync()`
- `release_usage()` / `release_usage_sync()`
- `extend_usage()` / `extend_usage_sync()`

The sync functions use a synchronous HTTP client and do not call
`asyncio.run()`. The SDK does not retry lifecycle calls automatically. Reuse
the exact operation, reservation, and extension identifiers when explicitly
replaying an identical request. `report_usage()` remains post-call tracking
only; it is not a pre-dispatch authorization API.

Adapter authors can bind an SDK-owned `reserved` decision across the matching
provider/tool attempt with `controlled_operation_ownership(reservation)` and call
`should_suppress_legacy_telemetry(...)` with exact operation and reservation
identifiers. Suppression requires both identifiers and proof of the
validated, correlated reservation; bypassed, denied, unavailable, copied, or
fabricated responses are insufficient. Ownership deliberately survives commit
timeouts and malformed or lost acknowledgements: the authoritative reservation
will settle or become unresolved, so emitting a second legacy event would
double-count it. The context-local, generation-guarded marker prevents that
duplicate without suppressing unrelated concurrent calls.

## Controlled OpenAI and Anthropic calls

Legacy auto-patching remains backward-compatible, best-effort telemetry. It is
not a fail-closed authorization surface. Use the explicit wrappers when a
provider call must be bounded before dispatch:

```python
from openai import OpenAI
import pylva

pylva.init(
    api_key="pv_live_...",
    control={"mode": "enforce", "on_unavailable": "deny"},
)

native = OpenAI()
openai = pylva.wrap_openai(native)
try:
    response = openai.chat.completions.create(
        model="gpt-4o-mini-2024-07-18",  # pin the priced model
        messages=[{"role": "user", "content": "Give me one concise sentence."}],
        max_completion_tokens=64,
    )
finally:
    # The controlled facade owns an independent private provider client.
    openai.close()
    native.close()
```

`wrap_anthropic(Anthropic())` provides the corresponding sync
surface; `AsyncOpenAI` and `AsyncAnthropic` keep their native awaitable shape.
Anthropic's `with client.messages.stream(...) as stream` and async context
manager are preserved, including observed `text_stream` and final-message
helpers. Await `controlled.close()` for an async facade.

One controlled async facade and every stream/manager it creates are bound to
the first event loop that performs an operation or close. Use them only on that
same operational loop. A call or close from another loop fails locally with
`PylvaStrictProviderError(reason="invalid_client")` before a new reservation or
provider network request. Do not share a facade across repeated
`asyncio.run()` calls. Await every controlled stream/manager close and then the
facade's `close()` before tearing down the owner loop.

The input must be an exact official provider client using its canonical API
base and default HTTP transport. Subclasses, custom base URLs, custom headers,
custom queries, credential callbacks, middleware/auth providers, and custom
HTTP transports are refused locally. Pylva copies only validated scalar
credentials into a new official client with `max_retries=0`; it never calls
`with_options()`, shares the caller's transport, or dispatches through a
caller-owned resource. The facade stores that private state in an internal weak
registry and exposes no original client, resource, or raw create method through
the supported public API. This narrows accidental access; it is not a security
boundary against hostile Python interpreter introspection.

The strict wrappers do not perform automatic model routing or cross-provider
failover. Choose the actual provider and model before each call. If your
application falls back from one provider to another, make a new call through
that provider's controlled wrapper; it receives a fresh operation and
reservation priced for the actual provider/model. A dispatched attempt with an
ambiguous outcome remains unresolved and is never reinterpreted as the
fallback's authorization. Legacy auto-patch routing/failover is not strict
enforcement and is not part of this guarantee.

The wrappers intentionally accept a small, priceable subset:

- text messages plus client-side function/tool schemas;
- exactly one explicit positive output-token cap;
- one output (`n=1`), standard/default service tier, and private dispatch retries off;
- no audio, images, remote/server tools, batch, flex/priority, cache controls,
  or provider-specific unpriced extensions;
- every other client/resource method fails closed; only OpenAI
  `chat.completions.create` and Anthropic `messages.create`/`messages.stream`
  are exposed by these controlled proxies;
- OpenAI's conservative complete local wire bound must remain below 1,024
  tokens, where automatic prompt caching is ineligible;
- Anthropic cache controls are absent and the conservative bound remains below
  the long-context pricing threshold.

Prompt text, tool arguments, schemas, and response bodies stay local. Before
reservation, the wrapper validates and detaches one bounded JSON snapshot. That
same detached request is used for the conservative input bound and provider
dispatch, so caller mutations during the reservation gap cannot change what is
sent. The control request receives only provider/model identifiers, trace
correlation, an input-token upper bound, and the explicit output cap. Cycles,
custom mapping objects, excessive depth, and oversized local values are refused
before any reservation or provider call.

Rollout behavior follows `control` configuration. `legacy` performs no control
I/O; `shadow`, no-applicable-budget bypasses, and `enforce` with
`on_unavailable="allow"` dispatch honestly and retain one legacy billing event.
Only `mode="enforce"` plus `on_unavailable="deny"` provides the no-spend-on-
denial/fail-closed guarantee for paid paths routed through supported controlled
integrations. A validated `reserved` decision owns the attempt, so a lost
commit acknowledgement never causes duplicate legacy billing.

### Trust boundary

The SDK is a cooperative integration boundary, not a hostile same-process
sandbox. Code with a provider credential and unrestricted provider egress can
send an unwrapped request; Python code can also deliberately introspect or
monkeypatch library state. If plugins, tenants, agents, or other application
code are adversarial, do not give that process reusable provider credentials or
direct provider egress. Put provider dispatch behind a trusted control-plane
proxy that owns reserve/dispatch/settle, with secret and network isolation
preventing bypass.

Post-dispatch uncertainty never replaces a successful provider result. Missing
usage, a different returned model/tier, paid-cache evidence, an early stream
break, or a settlement failure leaves the reservation to expire as unresolved.
Long calls and streams extend their lease every 100 seconds by default; custom
heartbeat intervals must be between 1 and 100 seconds, and abandoned objects
are finalizer-guarded with a one-hour maximum heartbeat lifetime. Facade or
stream closure stops the registered heartbeat and schedules the private raw
provider close exactly once. On an async stream failure, raw shutdown is
scheduled before the first cancellation point, so cancelling the consumer
cannot strand an unscheduled provider close; keep the owner loop alive until
that shutdown completes.

Framework adapters can read `current_controlled_attempt()` only while the real
provider/tool invocation is active. Its discriminated context includes exact
operation, reservation (when owned), trace/span, identity, target, and whether
legacy telemetry is required. The binder is SDK-private, so supported public
APIs cannot fabricate deduplication authority. As described above, this does
not claim resistance to hostile same-process introspection or monkeypatching.

## Controlled non-LLM calls

Use `controlled_usage_sync()` or `await controlled_usage()` around a paid tool
when you can state a conservative maximum quantity before dispatch and extract
the exact quantity from the response afterward:

```python
import pylva

result = pylva.controlled_usage_sync(
    cost_source_slug="document-parser",
    tool_name="Document Parser",
    metric="page",
    maximum_value=25,
    customer_id="acme-corp",
    invoke=lambda: parser.parse("private://contract.pdf"),
    extract_actual=lambda response: response["usage"]["pages"],
)

parsed_document = result.value
print(result.control.settlement, result.control.actual_value)
```

For calls whose exact billable quantity is known before dispatch, use
`controlled_exact_usage_sync()` or `await controlled_exact_usage()`:

```python
result = pylva.controlled_exact_usage_sync(
    cost_source_slug="email-delivery",
    tool_name="Email Delivery",
    metric="message",
    value=1,
    customer_id="acme-corp",
    invoke=lambda: mailer.send(message),
)
```

Both helpers reserve immediately before `invoke`. A reserved call commits its
exact usage once. If actual usage exceeds the declared maximum, Pylva still
commits the truth and returns `control.bound_violated=True`; it never hides the
overage. Missing or invalid post-dispatch evidence, a commit failure, a provider
exception, or a configuration change leaves the reservation unresolved for
expiry instead of releasing a possibly charged call. A proven pre-dispatch
failure may release it as `provider_not_called`. In enforce + deny mode, a
denial or control outage makes zero tool calls.

The returned `ControlledUsageResult` contains the untouched provider value and
a content-free control outcome. Tool arguments, queries, URLs, provider values,
and provider exception text never enter reservation payloads or outcomes.
Legacy, shadow, no-budget, and enforce + allow attempts remain tracking-only and
emit one legacy usage event when exact usage is available.

For Tavily basic search, the SDK includes a one-credit adapter with no Tavily
runtime dependency:

```python
from tavily import TavilyClient
import pylva

search = pylva.controlled_tavily_search_sync(
    TavilyClient(),
    "private research question",
    customer_id="acme-corp",
)
results = search.value
```

`controlled_tavily_search_sync()` and `await controlled_tavily_search()` accept
basic search only. They force `auto_parameters=False` and `include_usage=True`,
reserve exactly one credit, and reject missing, zero, boolean, floating-point,
or otherwise ambiguous credit evidence. Advanced and automatic searches must
use the generic bounded helper with an explicit conservative maximum.

## Package name

The PyPI distribution package is `pylva-sdk`; the runtime import package is
`pylva`:

```bash
pip install pylva-sdk
```

```python
import pylva
```

### Failover (reliability_failover rules)

If you use `reliability_failover` rules, switch to the explicit-client
constructor so Pylva has a handle to the backup provider:

```python
from openai import OpenAI
from anthropic import Anthropic
from pylva import Pylva

Pylva(
    api_key="pv_live_...",
    openai=OpenAI(),
    anthropic=Anthropic(),
    providers={"openrouter": openrouter_client},
)
```

Use `providers={...}` for any additional provider id exactly as it appears in
your rules or telemetry.

`pylva.init(api_key)` keeps working for telemetry-only deployments. In
v1.0, the SDK detects active cross-provider failover states and surfaces
warnings; actual backup-provider dispatch is still beta/internal and is not
part of the stable launch promise.

## Auto-instrumentation

Importing `pylva` monkey-patches any `openai` / `anthropic` modules
already loaded. Patches are isolated per R1 — SDK errors never propagate to
your agent.

Calls are captured with: `model`, `provider`, `tokens_in`, `tokens_out`,
`latency_ms`, `status`, `step_name` (if set), `customer_id`. Cost is computed
server-side.

## Tracking context

```python
from pylva import track_context

with track_context(customer_id="acme-corp", step="authentication"):
    resp = openai_client.chat.completions.create(...)
```

`track_context` is a `contextvars`-backed context manager; it threads
metadata across async + threaded boundaries correctly.

## LangGraph / LangChain callback

For LangGraph apps, use the callback handler when you want cost attribution by
graph run, node, and customer:

```bash
pip install "pylva-sdk[langchain]"
```

```python
import os
from pylva.langchain import PylvaCallbackHandler

handler = PylvaCallbackHandler(api_key=os.environ["PYLVA_API_KEY"])

graph.invoke(
    {"question": "Where did spend increase?"},
    config={
        "callbacks": [handler],
        "metadata": {"pylva_customer_id": "cust_acme"},
    },
)
```

The handler reads LangChain usage metadata, preserves LangGraph run ids, uses
`langgraph_node` as the default step name, and never captures prompt,
completion, tool input, or tool output text.
Metadata step labels from `langgraph_node`, `langgraph_step`, and `pylva_step`
must be identifier-like (`[A-Za-z0-9_.:/-]`, max 100 chars). Free-text prompts
or messages should never be placed in metadata; unsafe labels are ignored.

## Non-LLM costs

For automatic LangGraph / LangChain tool-call tracking, use dashboard policy
mode. Unknown tools are sent to Cost Sources as pending discoveries; they do
not affect customer cost until a builder marks them tracked and configures the
metric, unit, matchers, and price in the dashboard.

```python
from pylva.langchain import PylvaCallbackHandler

handler = PylvaCallbackHandler(
    api_key="pv_live_...",
    non_llm={"mode": "policy"},
)
```

You can provide a usage extractor when a tracked tool consumes more than one
unit per call:

```python
handler = PylvaCallbackHandler(
    api_key="pv_live_...",
    non_llm={
        "mode": "policy",
        "usage_extractors": {
            "tavily": lambda ctx: 1,
        },
    },
)
```

`track_tool_calls=True` is still supported for backwards compatibility, but it
records every observed tool call as `calls=1`. Prefer policy mode for production
cost attribution.

For explicit non-LLM usage reporting, keep using `report_usage()`:

```python
from pylva import report_usage

report_usage(
    customer_id="acme-corp",
    tool="translation",
    metric="characters",
    value=4200,
    step="translation",
)
```

## Reactive budget enforcement (B2a)

When a builder configures a `budget_limit` rule with `hard_stop=True`, the
SDK enforces **pre-call**:

```python
import pylva
from pylva import PylvaBudgetExceeded, BudgetExceededSource

pylva.init(api_key="pv_live_...")

try:
    resp = openai_client.chat.completions.create(...)
except PylvaBudgetExceeded as err:
    print(f"Budget hit for {err.customer_id}: ${err.accumulated_usd:.2f} / ${err.limit_usd:.2f}")
    print(f"Source: {err.source.value}")  # 'sdk_precall' or 'backend_ingest_flag'
    # graceful degradation
```

### How it works

- **Every matching rule is enforced.** A call is checked against ALL
  applicable `budget_limit` rules — a customer-specific cap AND any global
  cap both apply (strictest wins), matching the server's own
  `budget_exceeded` semantics. Untracked calls (outside `pylva.track()`)
  are enforced under the `anonymous` identity, the same identity their
  telemetry is billed to.

- **Pre-call accumulator (per-process `dict` + `threading.Lock`).** Keyed on
  `(rule_id, scope_token, period_start)`. Completed LLM calls are priced
  from the local pricing cache at enqueue time and recorded against every
  applicable rule's accumulator, so a hard stop engages on the very next
  call — no backend round-trip required. If the local view is already over
  a hard-stop limit, the SDK raises
  `PylvaBudgetExceeded(source=BudgetExceededSource.SDK_PRECALL)`. The
  exact-limit boundary blocks (`>=`, matching the server).

- **Backend-authoritative flag.** Every ingest response may carry
  `budget_exceeded[]`. The SDK bumps local accumulators to `limit + 1`
  on receipt; next pre-call raises `source=BACKEND_INGEST_FLAG`.

- **5-min sync loop.** A `threading.Timer` re-POSTs accumulator state to
  `/api/v1/budget/sync` and overwrites local with the server truth
  (not additive).

- **Passthrough.** Cold rules cache or unreachable backend → pre-call is a
  no-op. Your agent never blocks due to Pylva being degraded (R5).

### Rule behavior matrix

| `type`           | `hard_stop` | Behavior                                                                 |
| ---------------- | ----------- | ------------------------------------------------------------------------ |
| `budget_limit`   | `True`      | Pre-call raises `PylvaBudgetExceeded`; LLM call skipped.                 |
| `budget_limit`   | `False`     | Pre-call prints an advisory warning (1/min per rule); LLM call proceeds. |
| `cost_threshold` | n/a         | Post-call evaluation only (backend); no SDK-side enforcement.            |

## Webhook verification

```python
import os
from pylva import verify_webhook, InvalidSignatureFormat

def handle_webhook(body: str, signature: str, timestamp: str):
    try:
        ok = verify_webhook(body, signature, os.environ["WEBHOOK_SECRET"], timestamp)
    except InvalidSignatureFormat:
        return 400
    if not ok:
        return 400
    # ...
```

`verify_webhook` accepts both raw hex and the `sha256=<hex>` GitHub-style
prefix (B2a D34 parity with TS SDK). Default timestamp tolerance is 300 s.

## Privacy & PII

Pylva **does not redact** `step_name`, `customer_id`, or `metadata`
values. Do **not** pass raw user message content, email addresses, or phone
numbers into these fields. LangGraph metadata step labels are accepted only
when they are identifier-like; other validation rejects HTML and most control
characters. This does not protect against free-form PII.

SDKs never auto-redact by design: regex redaction is noisy and incomplete, and
classifier redaction would add an LLM round-trip to the hot path. PII handling
is the builder's responsibility; we provide exportable data and deletion
endpoints.

## License

MIT.
