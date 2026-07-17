# SDK 1.2.0 Candidate Release Notes: Authoritative Cost Control

> Status: source candidate only. `@pylva/sdk` and `pylva-sdk` 1.2.0 have not been published,
> tagged, deployed, or approved for stable release by this repository change. Independent QA on
> 2026-07-17 found release-blocking evidence and product gaps listed in the readiness checklist.

SDK 1.2.0 adds an explicit, opt-in path for preventing supported paid LLM and non-LLM operations
before they are dispatched. PostgreSQL owns the reservation decision and lifecycle; ClickHouse is a
retryable analytics projection and never authorizes spend.

The existing 1.x defaults remain `legacy` control mode with availability-compatible behavior.
Upgrading the package alone does not begin blocking calls.

## What is new

- A versioned reserve, commit, release, extend, and readiness contract shared by the backend,
  TypeScript SDK, and Python SDK.
- Server-priced, atomic reservations across pooled and per-customer budget rules, with exact
  settlement and durable refusal evidence.
- Explicit strict OpenAI and Anthropic wrappers in both SDKs; TypeScript also includes controlled
  Vercel AI helpers.
- Exact and bounded non-LLM helpers in both SDKs, plus a price-complete one-credit Tavily basic-search
  adapter.
- LangGraph callback ownership that keeps graph attribution without duplicating a wrapper-owned
  reservation, settlement, or legacy billable event.
- Durable PostgreSQL outbox projection, reconciliation, expiry handling, and a budget-activity
  dashboard that shows allowed spend and refusals separately.

Primary public entry points include:

| TypeScript                                                                                     | Python                                                              |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `ready()` / `controlStatus()`                                                                  | `ready()` / `ready_sync()`                                          |
| `reserveUsage()` and lifecycle methods                                                         | `reserve_usage()` / `reserve_usage_sync()` and lifecycle methods    |
| `wrapOpenAI()` / `wrapAnthropic()`                                                             | `wrap_openai()` / `wrap_anthropic()`                                |
| `createControlledOpenAIChatModel()` plus `controlledGenerateText()` / `controlledStreamText()` | Use the explicit provider wrappers                                  |
| `controlledUsage()` / `controlledExactUsage()`                                                 | `controlled_usage()` / `controlled_usage_sync()` and exact variants |
| `controlledTavilySearch()`                                                                     | `controlled_tavily_search()` / `controlled_tavily_search_sync()`    |

## Strict LLM coverage in 1.2

The initial price-complete subset is deliberately narrow:

- OpenAI Chat Completions and Anthropic Messages;
- text and client-side function/tool schemas;
- one completion with an explicit maximum output bound;
- standard/default service tier;
- provider retries disabled; and
- base input and output token pricing only.

Before dispatch, strict mode refuses unsupported cache writes/reads, paid server tools, remote media,
audio, batch/premium tiers, ambiguous long-context pricing, missing bounds, and unknown paid request
fields. If a dispatched response lacks exact supported usage evidence, the SDK preserves the provider
response but does not commit an inaccurate charge or release the hold; the reservation remains
unresolved for expiry and reconciliation. Prompts, completions, messages, URLs, tool
arguments/results, credentials, and raw provider errors are not sent in control requests or stored as
control diagnostics.

Provider routing and fallback are caller-owned. Each separately attempted provider/model must pass
through its own wrapped call and receives its own operation and reservation identity. The SDK never
silently performs an unauthorized fallback.

The TypeScript Vercel AI path requires AI SDK 6.x and `@ai-sdk/openai` 3.x. Callers create an opaque
model token with `createControlledOpenAIChatModel({ apiKey, model })`; only that exact Pylva-owned
token is accepted by `controlledGenerateText()` and `controlledStreamText()`. The token is frozen,
empty when serialized, and contains no public credential or provider-model fields. Direct official
models, structural lookalikes, cloned or forged tokens, custom endpoints/transports/headers, and
OpenAI Responses models are refused before control or provider I/O.

## Non-LLM coverage in 1.2

Pylva can stop a non-LLM operation only when the application routes it through a controlled helper
before dispatch and supplies a known cost source, metric, and conservative maximum. A refusal or
fail-closed control error invokes the tool zero times.

Legacy `reportUsage()` / `report_usage()` remains tracking-only. Reporting after a tool has run can
record its cost, but cannot prevent that cost.

The Tavily helper is currently a structural client protocol around the supported basic-search
shape. It has not yet been validated against a declared range of official Tavily package versions,
so do not describe it as broad official-client compatibility until that matrix exists.

## Trust and async runtime boundary

The 1.2 SDK guarantee is a cooperative integration guarantee, not a hostile same-process sandbox.
Every paid operation must be routed through a supported controlled wrapper or helper. Code that has
a provider credential and unrestricted provider egress can call the provider around an in-process
SDK; Python also permits deliberate interpreter introspection and monkeypatching. Deploy adversarial
plugins, tenants, agents, or application code without reusable provider credentials or direct
provider egress, behind a trusted control-plane proxy that owns reserve/dispatch/settle.

Python controlled `AsyncOpenAI` and `AsyncAnthropic` facades and their streams bind to the first
operational event loop. Later use or close from another loop fails locally as `invalid_client`
before a new reservation or provider network request. Applications must await every controlled
stream/manager and facade close before tearing down the owner loop. On async provider-stream
failure, Pylva schedules exact-once raw provider shutdown before its first cancellation point so
caller cancellation cannot strand an unscheduled close; the owner loop must remain alive until that
shutdown finishes.

## Backend and operations prerequisites

Before deploying applications that use these APIs:

1. Apply every pending PostgreSQL migration through `054` using the phased migration procedure. A
   database below 048 must run `pre_roll`, deploy the scope-compatible application, and then run
   `post_roll`; do not apply only 050–054 or run an unqualified full migration before crossing that
   boundary. Apply ClickHouse migrations through `012` using the documented migration identity.
   Migration 012 pins legacy `cost_events.timestamp` storage to UTC without changing existing
   epochs.
2. Provision and attest an ordinary `GENERAL_APP_DATABASE_URL` login through the migration-054
   fixed-owner bridge. Keep it distinct from both the migration and authoritative-budget identities.
3. Provision and attest a distinct `BUDGET_CONTROL_DATABASE_URL` login with the sealed runtime role.
4. Provision distinct general, projector, and administrative ClickHouse identities, then run
   `pnpm clickhouse:provision-budget-rbac` in every deployment access-control scope.
5. Keep the reservation-expiry and authoritative-projection schedulers active, including while new
   reservations are disabled.
6. Reconcile current-period authority and complete shadow/canary gates before enabling strict client
   traffic.
7. Enable the backend and SDK modes explicitly; use `enforce` plus `onUnavailable: 'deny'` (Python:
   `on_unavailable='deny'`) for the no-dispatch-on-control-failure guarantee.

Production requires the dedicated PostgreSQL and ClickHouse identities even when
`ENABLE_AUTHORITATIVE_BUDGET_CONTROL=false`, because rule mutations and previously created lifecycle
and projection work still depend on them.

See the [HTTP contract](./authoritative-budget-control-rollout.md#machine-http-contract),
[SDK architecture](./authoritative-budget-control-rollout.md#sdk-architecture-and-controlled-attempt-lifecycle),
[LangGraph ownership guide](./langgraph-authoritative-control.md),
[PostgreSQL migration safety procedure](./authoritative-budget-control-operations.md#postgresql-migration-phase-and-rollback-safety),
[upgrade and rollout guide](./authoritative-budget-control-rollout.md),
[operations runbook](./authoritative-budget-control-operations.md), and
[release-readiness checklist](./authoritative-budget-control-release-readiness.md) before activation.

## Compatibility and rollback

- The telemetry wire remains schema 1.6; the authoritative control wire is separately versioned.
- Old SDK/new backend traffic remains legacy unless control is explicitly configured.
- New SDK/unsupported or disabled backend behavior follows the configured strict or availability
  fallback; it never fabricates an authoritative allow decision.
- Disable new reservations with the backend flag only after clients have been moved to `legacy` or an
  approved availability fallback. Keep expiry and projection workers running for existing records.
- A future major release, not 1.2.x, may reconsider the default mode after adoption and migration
  evidence.

## Release status

The recorded local artifact runs establish useful core-path evidence; they do not establish source,
artifact, or release readiness while the independent-QA blockers remain open. The final local
TypeScript tarball is frozen at SHA-256
`776c4e7683adbb7f276e837507c38728e2365e1dac228f11f02addd674edabf3` and has passed its local
package/profile/size gates. The final Python wheel is frozen at SHA-256
`f26aeacad94aa073c42c764968cb7b4d3361fb99f622e4cf20882fe36ff8d74d` and its sdist at SHA-256
`8574d814089a243787e9ef751eaee8e39be7305f46db5eaf5daedb563eb20175`; archive inspection and all
four wheel/sdist floor/current profiles pass with stable hashes. Those immutable TypeScript and
Python candidates also pass the final local two-SDK chaos group 11/11 and LangGraph group 4/4 across
three files.
Stable 1.2.0 still requires a frozen commit on `main`, green recorded workflow URLs, the production
scheduler rehearsal, shadow comparison, internal canary, release-owner approval, and the documented
tag-triggered trusted-publishing procedure. It also requires closure of every current blocker in the
release-readiness checklist, followed by new evidence generated from one exact frozen SHA through
build, integration, publish, deploy, and production canary.
