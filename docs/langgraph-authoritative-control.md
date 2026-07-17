# LangGraph authoritative-control ownership

Pylva provider wrappers own LLM reservation, settlement, and the single
billable record. Explicit controlled non-LLM helpers own the same lifecycle for
their tool calls. LangGraph callbacks provide graph/node observation without
creating a second billable record for those owned calls.

## Callback LLM modes

TypeScript uses `llmTracking`; Python uses `llm_tracking`.

| Mode       | Behavior                                                                                                                                                                                           |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auto`     | Default. The provider wrapper owns reserved and rollout-fallback telemetry. Suppression requires either an exact active provider attempt or the explicit per-invocation control scope shown below. |
| `callback` | Callback-only instrumentation for an unwrapped model. It emits the callback LLM event even if a wrapper context is present, so do not combine this mode with explicit provider wrappers.           |
| `off`      | Ignore LLM callbacks. Chain and configured tool observation remain available.                                                                                                                      |

Invalid mode values fail synchronously during handler construction.

The control scope is a correlation boundary only. It does not initialize
Pylva, patch a provider client, or turn a callback-only model into an
authoritatively controlled model. Initialize the root SDK and use an explicit
strict provider wrapper (`wrapOpenAI`/`wrapAnthropic` or
`wrap_openai`/`wrap_anthropic`) or an explicit controlled-tool helper before
making an enforcement promise. The TypeScript `@pylva/sdk/langgraph`
entrypoint intentionally does not auto-patch providers.

```ts
import { PylvaCallbackHandler, withLangGraphControlScope } from '@pylva/sdk/langgraph';

const handler = new PylvaCallbackHandler({ llmTracking: 'auto' });

const response = await withLangGraphControlScope(() =>
  model.invoke(messages, { callbacks: [handler] }),
);
```

```python
from pylva.langchain import PylvaCallbackHandler, langgraph_control_scope

handler = PylvaCallbackHandler(llm_tracking="auto")

with langgraph_control_scope():
    response = await model.ainvoke(messages, config={"callbacks": [handler]})
```

Use one control scope for one billable model or controlled-tool invocation.
Concurrent calls and each item in an explicit batch need separate scopes. Do
not wrap an entire multi-step agent loop in one scope.

## Runtime and trust boundaries

The callback/control scope coordinates cooperative integrations; it is not a
security sandbox for graph nodes. Every paid node must call a supported
controlled provider or tool surface. If graph nodes, tools, plugins, or tenants
are adversarial, they must not hold reusable provider credentials or direct
provider egress. Put those capabilities behind a trusted control-plane proxy
that owns reserve/dispatch/settle and enforce the boundary with secret and
network isolation.

In Python, one controlled `AsyncOpenAI` or `AsyncAnthropic` facade and every
stream or manager it creates belong to the facade's first operational event
loop. Invoke them on the LangGraph worker loop that owns the facade; a later
wrong-loop operation or close fails locally as `invalid_client` before a new
reservation or provider network request. Do not reuse a facade across repeated
`asyncio.run()` calls. At worker shutdown, cancel or close graph work, await all
controlled streams/managers and the facade's `close()` on the owner loop, and
only then tear the loop down. Async stream failures schedule exact-once raw
provider shutdown before the first cancellation point, but completion still
depends on keeping that loop alive.

## Exact ownership, not heuristics

The TypeScript and Python SDKs bind a private, async-safe correlation context
only around the real provider invocation. It contains the operation,
reservation, trace, span, customer, SDK identity generation, and ownership
state. The context is discriminated as `llm` or `tool` and includes the
corresponding pricing identity.

LangChain normally sends the callback start before the low-level provider
wrapper dispatches. The public control scope creates a private rendezvous: the
callback registers its run, then the provider wrapper links the exact
operation/reservation when dispatch begins. A pre-dispatch refusal links the
same callback to exact no-dispatch evidence, so LangChain's error callback
cannot fabricate a billable provider/tool failure. The callback keeps its
immutable link until its terminal event. If a provider wrapper is already
active at callback start, it captures that same exact correlation directly.

The SDK never deduplicates by model name, tool name, elapsed time, or nearby
callback order. During callback-first rendezvous, a scope with zero or more
than one pending callback cannot be matched exactly, so Pylva warns and leaves
callback telemetry unsuppressed. Provider-first ordering can still capture the
one active operation directly. This honest fallback prevents a guessed match
from hiding real spend. Separate scopes keep nested and concurrent calls
isolated even when provider, model, tool, and LangGraph node metadata are
identical.

The scope also snapshots any operation that was already active outside it.
That outer operation cannot claim a nested callback: an unwrapped nested call
remains callback-billed, while an inner controlled dispatch links its own
operation. Without the explicit scope, two same-kind nested calls are
indistinguishable at callback start, so use the scope at every nested billable
invocation boundary.

- A schema-valid `reserved` decision remains wrapper-owned if the commit
  acknowledgement is lost; the callback does not emit a duplicate legacy
  event.
- `bypassed` and allowed `unavailable` attempts remain wrapper-owned for
  fallback telemetry; the callback does not duplicate that event.
- A controlled tool callback is suppressed for both authoritative settlement
  and fallback reporting. An unrelated active LLM context cannot suppress it.
- An exact pre-dispatch LLM or tool refusal suppresses only its matching error
  callback. The refused provider/tool closure is never called and no legacy
  failure event is created.
- Reinitializing the SDK invalidates the active correlation and drops late
  terminal callbacks from the old builder identity. Packaged TypeScript root
  and LangGraph entrypoints share the private identity/reset boundary, so an old
  deep-entrypoint telemetry buffer cannot cross into a new tenant.
- Mutable lifetime leases fence async tasks that inherit context: after the
  provider invocation or public scope settles, an orphan task cannot reuse
  stale ownership to suppress a later callback.
- Duplicate terminal callbacks are fenced by bounded run tombstones.

## Graph attribution

Reservation attribution is fixed before the provider call. Put Pylva tracking
context around the graph or node before calling the explicit provider wrapper
so the reservation receives the intended customer, trace, step, and
`langgraph` framework. Callback metadata is observational and cannot mutate an
already-sent reservation.

The callback never stores prompts, completions, tool arguments, tool outputs,
or provider error messages.

## Verification

Focused CI consumes the generated immutable TypeScript tarball and Python wheel from the candidate
artifact jobs. The exact hashes, dependency resolution, and run URLs belong in the release record
for the frozen commit rather than this source document.

These local results validate the exercised path, but they do not yet close release evidence:

- the service fixtures now allow only configured Pylva API paths and the explicitly mocked canonical
  provider route; unexpected origins and paths fail before network I/O;
- the service assertion reconciles operation, reservation, trace, and step identity but does not
  yet assert `span_id` and `parent_span_id` continuity;
- there is no installed-artifact matrix for a real streaming `StateGraph` invocation that exercises
  strict wrappers and callbacks together without duplicate billing; and
- the local 4/4 result is not a frozen-commit CI record or a publish/deploy attestation.

Treat those items as release blockers, not as reasons to discount the valid local coverage below.

The SDK suites cover:

- real installed TypeScript and Python `StateGraph` invocations;
- clean built TypeScript and wheel-installed Python artifacts running through
  real HTTP control routes and the PostgreSQL ledger/outbox;
- `auto`, `callback`, and `off` behavior;
- reserved, bypassed, unavailable, and lost-acknowledgement ownership;
- controlled tool fallback with exactly one report;
- nested and concurrent identical-model attempts;
- faithful callback-start-before-provider-dispatch ordering;
- allow-and-commit LLM/tool journeys followed by exact pre-dispatch refusal,
  with zero refused provider/tool calls and zero duplicate legacy events;
- zero-match and ambiguous multi-callback scope fallbacks;
- orphan/background tasks that inherit async context after scope exit;
- SDK identity reinitialization and duplicate terminal callbacks; and
- sync/async Python callback parity.

Relevant tests:

- `packages/sdk-ts/tests/langgraph_control_dedup.test.ts`
- `packages/sdk-ts/tests/controlled_usage.test.ts`
- `packages/sdk-py/tests/test_langgraph_control_dedup.py`
- `packages/sdk-py/tests/test_langgraph_stategraph_journey.py`
- `packages/sdk-py/tests/test_controlled_usage.py`
- `tests/integration/langgraph-authoritative-sdk-e2e.test.ts`
