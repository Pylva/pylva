# pylva (Python)

Cost infrastructure for AI agent businesses. Auto-instruments `openai` and
`anthropic` clients; emits server-priced telemetry to your Pylva backend.

Version `1.1.0` strengthens budget enforcement: ALL matching budget rules
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

| `type` | `hard_stop` | Behavior |
|---|---|---|
| `budget_limit` | `True` | Pre-call raises `PylvaBudgetExceeded`; LLM call skipped. |
| `budget_limit` | `False` | Pre-call prints an advisory warning (1/min per rule); LLM call proceeds. |
| `cost_threshold` | n/a | Post-call evaluation only (backend); no SDK-side enforcement. |

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
