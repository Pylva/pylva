# Pylva Authoritative All-Cost Control Decisions

This log records durable architectural and product decisions made while implementing `docs/authoritative-all-cost-control-plan.md`. Append a dated entry when a decision changes public behavior, wire contracts, persistence, failure semantics, compatibility, or rollout.

## 2026-07-13 — Initial decisions

### D001: PostgreSQL is the control authority

PostgreSQL owns atomic budget accounts, reservations, allocations, and settlement state. ClickHouse is an analytics projection. Redis and SDK-local accumulators are not authoritative because they cannot provide durable cross-process correctness.

### D002: Control uses reservations, not check-only preflight

A budget check without a hold is inherently racy. Every allowed controlled operation creates an atomic reservation across all applicable budget accounts before provider dispatch.

### D003: Clients report bounded usage units, not dollars

The backend prices LLM token bounds and non-LLM metric bounds using authoritative pricing. This preserves Pylva's report-usage-not-cost contract and prevents clients from weakening enforcement with a false monetary estimate.

### D004: Exact budget equality is allowed

Authorization allows `committed + reserved + unresolved + requested <= limit`; it refuses only when the projected total exceeds the limit. Any later positive-cost action is refused once the limit is fully consumed.

### D005: Ambiguous usage remains unresolved

If provider dispatch may have occurred but actual usage is unknown, the reservation is not released or billed as confirmed actual spend. It moves to unresolved capacity, counts against control, and remains reconcilable.

### D006: Control is additive and opt-in in SDK 1.x

Existing `init()`, `reportUsage()`, and `report_usage()` behavior stays compatible. SDK 1.x defaults to legacy/fail-open operation. Strict enforcement requires explicit `control.mode=enforce` and `control.onUnavailable=deny`.

### D007: Blocked actions are control records, not cost events

A refusal is not a provider call and must not inflate spend, event counts, billing, or provider failure rates. It is persisted in the control ledger/activity model and linked to traces separately.

### D008: Wrappers own LLM billing; callbacks own graph attribution

Provider wrappers perform LLM reservation, settlement, and billable telemetry. LangGraph callbacks retain node/trace attribution and tool observation, suppressing duplicate LLM billing when a wrapper-owned operation exists.

### D009: Strict control requires a bounded maximum

Operations without known pricing or a conservative maximum cannot receive a strict no-overauthorization guarantee. Enforce mode returns an explicit unavailable/usage-bound-required decision; shadow and legacy modes may continue with clear tracking-only status.

### D010: The first controlled non-LLM adapter is Tavily Search

Tavily Search provides a bounded, understandable credit unit and is sufficient for the first all-cost demonstration. Generic reservation helpers remain the primary extension point for other tools.

### D011: Public naming follows each SDK; the wire stays snake_case

The TypeScript facade uses camelCase and the Python facade uses snake_case. Both map exactly once to a strict snake_case wire contract. The controlled tool identifier is `cost_source_slug` on the wire and in Python, and `costSourceSlug` in TypeScript; the existing `cost_source` field remains reserved for telemetry provenance such as `auto` or `configured`.

### D012: Lease extension is part of the public lifecycle

Both SDKs expose reservation extension alongside reserve, commit, and release. A private-only extend endpoint would make long-running operations unable to uphold the public lease guarantee.

### D013: Authoritative equality does not silently change legacy semantics

The versioned authoritative contract permits a reservation that lands exactly on the limit. Legacy local accumulation keeps its existing equal-to-limit refusal behavior for SDK 1.x compatibility. Enforce mode bypasses the legacy local throw; shadow mode records both outcomes but never throws.

### D014: Reconfiguration invalidates builder-scoped control state

SDK initialization maintains a monotonic configuration generation. Changing the endpoint or API key invalidates control capabilities, rules, pricing, and non-LLM policy caches and discards late in-flight results from older generations, preventing one builder's state from crossing into another configuration.

### D015: Exactly-once authority is PostgreSQL, not an unproven ClickHouse projection

PostgreSQL controlled usage and its transactional outbox are the exactly-once source for control and billing. ClickHouse projection must be idempotent and reconciled, but Pylva will not promise exactly-once analytics until lost acknowledgements, retries, and every dependent materialized view are proven against the deployed ClickHouse design. Billing reads PostgreSQL authority or is gated on a verified projection watermark and drained outbox.

### D016: Controlled commit owns controlled-path billable telemetry

A successful controlled commit creates the authoritative usage record and cost-event outbox entry. Wrappers and callbacks must not also enqueue the legacy telemetry event for the same provider attempt. This gives one owner for pricing, retention snapshots, idempotency, and analytics correlation.

### D017: Tool quantities use canonical decimal strings

Wire fields such as `maximum_value` and `actual_value` are canonical nonnegative base-10 decimal strings. SDK facades may accept precisely representable safe integers and Python `Decimal` values and then canonicalize them, but binary floating-point values never participate in authoritative request hashing or pricing.

### D018: The additive control release is SDK 1.2.0

The new control configuration, errors, lifecycle methods, and result types are additive root exports. Existing initialization, reporting APIs, defaults, and `PylvaBudgetExceeded` catch behavior remain compatible. Both SDK packages will move together to version 1.2.0 after their artifact and compatibility gates pass.

### D019: An operation ID identifies one priceable provider attempt

`operation_id` is the idempotency identity for one potential paid dispatch and is reused only for transport retries of that same dispatch. A routed fallback or failover that may create a separate provider charge receives a new operation ID and reservation while sharing trace and parent identifiers for logical-call attribution.

### D020: Extension retries have their own idempotency identity

Every extend request includes an `extension_id`. Replaying the same extension returns the stored result; a distinct extension ID requests an additional bounded extension. Reservation ID alone cannot distinguish a retry from a request to extend the lease again.

### D021: Requests are closed; responses are forward-compatible

Control request schemas reject unknown properties to catch typos and prevent private payload leakage. Response schemas ignore additive unknown properties after validation so a newer backend can add safe metadata without breaking older SDKs. Unknown discriminators, contradictory literals, malformed identifiers, and invalid values still fail validation.

### D022: Authoritative values use NUMERIC(38,18)-compatible strings

The v1 contract accepts nonnegative base-10 decimal-string syntax with at most 20 integer digits and 18 fractional digits. It canonicalizes the parsed string without floating-point conversion by removing trailing fractional zeros and a now-empty decimal point before hashing or pricing. PostgreSQL ledger columns use the corresponding fixed precision and scale. Scientific notation, signs, whitespace, redundant integer leading zeros, JSON numbers, and values beyond that representation are rejected.

### D023: Settlement carries sanitized telemetry outcome fields

Because controlled commit is the sole billable telemetry owner, reservation context includes a content-free framework value and commit includes provider-attempt status, latency, and stream-aborted state alongside actual usage units. The backend supplies server timestamps and SDK identity comes from headers. Prompts, messages, tool payloads, URLs, raw errors, and client-calculated dollars remain forbidden.

### D024: Unresolved is initially an expiry-owned transition

The first public contract has no client endpoint for marking a reservation unresolved. An ambiguous operation remains reserved until its server-owned lease expires; expiry atomically moves the protected amount from reserved to unresolved without changing total protected capacity. A late commit or a proven-uncharged release may settle unresolved capacity, while extension cannot revive an expired reservation.

### D025: SDK identity is authenticated transport metadata

Controlled requests carry validated `X-Pylva-SDK-Version` and `X-Pylva-SDK-Language` headers rather than client-supplied identity inside the hashed usage JSON. The backend stores these allowlisted values with authoritative usage and its outbox event. SDK version is limited to 50 printable ASCII characters and language is one of `python` or `typescript`; absent or invalid identity is recorded as `unknown` without weakening authorization.

### D026: Control timestamps use canonical UTC milliseconds

Control timestamps use canonical UTC `Z` notation and zero to three fractional-second digits. PostgreSQL and backend responses normalize them to that form. This avoids cross-SDK ordering differences from JavaScript millisecond dates, Python microsecond dates, and runtime-specific timezone-offset parsing while retaining all precision the public control lifecycle uses.

### D027: Store-safe text is defined across runtimes

Provider, model, and metric limits count Unicode scalar values rather than JavaScript UTF-16 code units. A single explicit blank-character set is shared semantically by TypeScript and Python, and lone UTF-16 surrogates are rejected before hashing, logging, or storage. This prevents cross-SDK accept/reject drift and guarantees accepted identifiers can be encoded as valid UTF-8.

### D028: Financial responses prove their own arithmetic

Runtime response validation uses exact 18-place integer arithmetic rather than floating point. A denied decision must exceed its deciding limit and report the exact pre-request remainder, and a commit must report exact released and overage amounts. `budget_exceeded_after_commit` reports whether any serialized hard-stop account total is over its captured limit after the posting; it is intentionally independent of the current operation's own overage because other holds, releases, or commits can determine the live total. Advisory exceeded warnings require `projected_usd > limit_usd`.

### D029: Integral JSON numbers have one canonical meaning

Token counts, latency, and lease durations accept JSON numeric lexemes such as `1` and `1.0` when their mathematical value is an in-range integer, then normalize them to an integer before hashing or use. Fractional values, booleans, non-finite values, negatives, and overflow remain invalid in both SDKs.

### D030: Allocation insertion is the serialized authorization boundary

Every applicable account is locked when its allocation is inserted. The allocation records the account version and exact committed, reserved, and unresolved values observed under that lock; its rule snapshot, enforcement, limit, customer scope, and period must match the account. A held allocation then posts its reservation to the account from a database trigger. A retained unique observed-version identity prevents two held allocations from authorizing against the same account version. Settlement allocation transitions post the corresponding committed, released, or unresolved counter movement. Direct account counter writes are rejected, and explicit closure equations remain available for reconciliation and corruption audits without imposing an O(history) scan on every posting.

### D031: Lifecycle transitions form a gap-free typed chain

Every extension, expiry, commit, and release records explicit from/to state versions and expiries. Versions advance exactly once, adjacent transition edges must join, and the final edge must equal the reservation's current state, expiry, version, and lifecycle timestamp. A live reservation may commit or release only before expiry; after expiry it first moves to unresolved. Release records one of the two public proof reasons, and stored request/response snapshots must match typed identifiers, amounts, timestamps, and replay semantics.

### D032: Retention produces coordinated tombstones, not missing authority

Usage details and an outbox payload may be removed only after the retention horizon and only after the cost event is projected and reconciliation-verified. The usage and outbox rows, hashes, typed cost facts, foreign keys, and uniqueness identities remain. Both JSON bodies are removed in one tenant-scoped transaction with an identical server timestamp; deferred checks reject one-sided purge, unpurge, premature purge, or purge of retryable projection work. This is detail/payload retention, not complete personal-data erasure.

### D033: Stored hashes and replay snapshots are database-verifiable

Snapshot and payload hashes are SHA-256 values of PostgreSQL's canonical JSONB text, not unrelated caller assertions. The ledger cross-checks normalized reservation requests, reserve decisions, lifecycle requests/responses, commit usage, advisory warnings, and the deterministic ClickHouse outbox payload against typed authoritative rows. This prevents an idempotent replay or analytics projection from contradicting the control decision even when all foreign keys still exist.

### D034: Legacy current-period spend is an explicit opening balance

A budget account may start with an immutable `opening_committed_usd` value recorded in its hashed initial snapshot. Account closure is `opening committed + retained committed allocation postings`; reserved and unresolved counters remain derived solely from retained allocation states. This supports current-period rollout reconciliation without an invisible mutable accumulator or fabricated controlled provider attempt.

## 2026-07-14 — Ledger hardening decisions

### D035: UUID identity is lowercase on the wire and semantic in PostgreSQL

Both SDK contract validators normalize accepted UUID strings to lowercase before hashing or transport, so equivalent UUID casing cannot create different idempotency identities. PostgreSQL validates UUID-bearing JSON by semantic UUID equality rather than case-sensitive text equality. Uppercase input remains acceptable only when it is otherwise a valid contract UUID; stored and returned contract identity is lowercase.

### D036: Lifecycle time is owned by PostgreSQL

Reservation creation, authorization, refusal, extension, commit, release, expiry, and lifecycle-transition timestamps are stamped or derived by PostgreSQL from server time. Callers cannot backdate, future-date, or extend authority by supplying trusted lifecycle timestamps. Stored responses are rewritten from those authoritative values and must remain within the public wire timestamp range.

### D037: Outbox processing uses worker-owned expiring leases

An outbox claim requires an identified worker and receives a server-timed finite lease. While that lease is active, only its owner may renew, release, or project the item; another worker may recover it only after expiry. Renewal must advance the expiry and projection timing is server-stamped, preventing permanent locks, early theft, and caller-authored processing time.

### D038: Allocations close over the exact applicable rule-revision set

Reservation insertion records a server-owned, sorted, hashed identity for every active global rule revision applicable to the customer, independently of account materialization. Initial authorization recomputes that current set at its fresh validation boundary and requires exactly one allocation per captured revision against a still-current period account. A missing account, partial/substituted allocation set, same-transaction configuration change, or period-boundary crossing fails closed. `no_applicable_budget` is valid only when the active applicable revision set is empty.

### D039: Running committed spend is wider than the public wire

Per-operation amounts, limits, openings, reservations, unresolved amounts, allocations, and public wire values remain `NUMERIC(38,18)`-compatible. The budget account's internal `committed_usd` accumulator is unbounded PostgreSQL `NUMERIC`, superseding D022 only for that internal running total, so a valid post-provider charge or overage is always retained. Workstream 3 must return an explicit unavailable result whenever a derived pre-dispatch value cannot fit the public wire representation.

### D040: Ledger authority restricts builder deletion

Builder deletion is restricted while authoritative budget accounts or reservations still depend on that builder. Retention removes eligible usage detail and outbox payloads through coordinated tombstones rather than cascading away decision, billing, replay, or reconciliation identity. Any future builder-erasure workflow must explicitly reconcile and preserve the ledger invariants before deleting authority.

### D041: Zero-dollar authorization still consumes serialization identity

A zero-dollar hold consumes the account's next authorization version even though it does not change monetary counters. This prevents a concurrent hold from reusing the same observed account version. Later zero-to-zero lifecycle settlement does not increment the account version because no reserved, committed, or unresolved posting changed; it must not create a phantom monetary mutation.

### D042: Rule configuration is globally revisioned over stable accounts

Each public rule has one immutable global active revision per builder. Limit and enforcement edits atomically supersede that revision without replacing per-period accumulator accounts, so pooled and every per-customer bucket retain committed, reserved, and unresolved spend. A pooled rule always has a null customer target; a per-customer rule may apply to every customer or one explicit target. Disable retires the active revision and may later be re-enabled with the next revision; deletion is terminal. A superseded revision and its exact successor must commit together. Scope, customer targeting, and period are structural identity and cannot change across revisions; changing them requires a new rule identity. The top-level `budget_accounts.enforcement` and `budget_accounts.limit_usd` columns are immutable origin-revision evidence, not current configuration after a rotation. Every current policy read and enforcement decision must join the active `budget_rule_revisions` row.

### D043: Configuration and authorization cannot mix after reservation capture

Rule revisions and account materialization take the exclusive builder configuration lock; reservation capture takes its shared form. Authoritative reservations require PostgreSQL `READ COMMITTED` isolation so a lock wait cannot retain a stale pre-configuration MVCC snapshot. PostgreSQL also records the creating transaction identity and rejects any account or rule-configuration write after a reservation has been inserted in that same transaction, closing re-entrant advisory-lock mutation. Workstream 3 must materialize accounts and rotate configuration before opening an authorization transaction, must never force the initially-deferred authorization constraints early, and must not dispatch after a captured account period has expired. Application policy reads performed before reservation insertion are outside the database linearization point; the backend must either acquire the same shared builder lock before those reads or retry any stale-allocation closure failure from a fresh transaction. Those transaction rules are part of the trusted backend boundary and require route/integration tests before enforcement can ship.

### D044: Outbox attempt provenance is immutable across worker transitions

The server stamps each claim's `last_attempt_at`. Lease renewal, retry release, and successful projection preserve that value; a pending row cannot rewrite audit fields before it is claimed again. Retry release may update only the bounded next-availability and sanitized error fields, while the attempt counter advances exactly once on the next server-owned claim.

### D045: Account materialization keeps strict builder-level authorization ordering

For the pre-roll, account insertion retains the exclusive builder-scoped transaction lock while reservation capture takes the shared form. This guarantees that an accumulator, its opening balance, and its provenance either commit before authorization capture or wait until that authorization finishes; a newly materialized account cannot appear halfway through a `READ COMMITTED` decision. The accepted tradeoff is head-of-line blocking when many hourly or per-customer buckets are first materialized concurrently. Workstream 3 must materialize accounts in a narrow, separate transaction. Release remains blocked until a high-cardinality first-use load gate proves acceptable latency and lock-wait behavior. A narrower lock requires reservation-time derivation and ordered locking of every prospective account identity and is deferred until that design has equivalent correctness evidence.

### D046: Outbox worker identity is a trusted cooperative lease identity

`app.outbox_worker_id` identifies a trusted backend worker; it is not database authentication or a cryptographic fencing token. Workstream 4 must generate a globally unique, non-reused ID for each live worker incarnation and predicate every release, renewal, recovery, and projection update on the expected status, owner, attempt, and authoritative lease boundary. Mutually untrusted actors must never receive the runtime database role. Projection verification initially shares that trusted tenant-scoped boundary; a separate verifier role is future hardening. Load gates must cover large pending/expired queues and alert far before the finite attempt counter could approach its operationally unreachable maximum.

## 2026-07-14 — Backend-control decisions

### D047: Shadow-mode control unavailability is an honest non-blocking bypass

When shadow mode cannot obtain authoritative pricing, a bounded usage value, a ready control ledger, or another prerequisite needed to calculate a truthful would-allow/would-deny result, it returns and persists `shadow_control_unavailable`. The result is `bypassed`, `allowed: true`, has a durable decision identity when PostgreSQL is available, has `would_have_denied: null`, and carries no fabricated pricing, requested dollars, or allocations. It must not be mislabeled as `no_applicable_budget`, `control_disabled`, or a calculated shadow outcome. Enforce mode continues to return the corresponding blocking `unavailable` result.

### D048: The operator kill switch is independent of ledger availability

When authoritative control is disabled by configuration, reserve returns the existing ephemeral `control_disabled` bypass with a null decision identity without opening a PostgreSQL transaction. This intentionally means operation-body conflict detection is unavailable while the kill switch is active. The tradeoff is explicit: an emergency disable must continue working during a database outage and must not create a new dependency on the subsystem being disabled.

### D049: Post-provider bound violations remain exactly recordable

The pre-dispatch requested amount, holds, limits, openings, releases, and ordinary public budget values remain `NUMERIC(38,18)`-compatible. A tool can nevertheless report an actual quantity above its declared maximum after the provider was called. With a v1 quantity bounded by `NUMERIC(38,18)` and an authoritative unit price bounded by `NUMERIC(12,6)`, the exact worst-case cost requires 26 integer and 18 fractional digits. A follow-up migration therefore widens only per-operation actual cost and overage evidence to `NUMERIC(44,18)`, and the commit response accepts that corresponding canonical decimal range. The account committed accumulator remains unbounded. The backend records the charge and retains the typed declared-versus-actual evidence needed to identify the bound violation; it never truncates, silently drops, or converts the charge to floating point.

### D050: Control readiness is typed PostgreSQL authority

Authoritative control cannot silently initialize an existing current-period account with zero legacy spend. Each builder must have an explicit tenant-owned readiness record before capabilities can report control enabled or reservation evaluation can begin. Readiness is not stored in mutable generic feature flags. Activation uses either exact reconciled opening balances with a recorded watermark or a safe future period boundary after which earlier legacy spend is outside every activated rule period. Missing, incomplete, or stale readiness fails closed in enforce mode and produces the honest non-blocking unavailability result in shadow mode.

### D051: Fractional authoritative cost rounds conservatively once

Authoritative pricing never converts through binary floating point. When exact nonnegative tool quantity multiplied across flat or volume-tier pricing has more than 18 fractional digits, PostgreSQL rounds the final summed cost upward once to 18 places. It does not truncate and does not round each tier independently. Reserve and commit use the same function, so the same quantity always has the same price, a declared maximum cannot be under-reserved by sub-attodollar fractions, and smaller actual usage cannot exceed the conservatively priced maximum solely because of rounding.

### D052: Exact-backfill readiness requires an operational traffic fence

A database row alone is not proof that current-period legacy spend stopped changing at the reconciliation watermark. The production readiness service therefore activates `next_period` directly only after its database-owned boundary. An `exact_backfill` cutover remains unavailable unless an explicit retry-safe adapter installs reconciled opening evidence under a durable legacy-traffic fence inside the same exclusive builder transaction. Capabilities stay disabled for exact-backfill builders until that operational adapter is configured. This prevents a checkbox-only cutover from authorizing against a stale opening balance.

### D053: Disabling new control does not stop lifecycle maintenance

`ENABLE_AUTHORITATIVE_BUDGET_CONTROL=false` stops new authoritative reservations, but it does not stop authenticated commit, release, or expiry maintenance for reservations that already exist. The expiry cron therefore does not consult the reserve kill switch. Otherwise an emergency disable could leave protected capacity permanently in `reserved` instead of moving an ambiguous expired operation to `unresolved`. The maintenance route remains fail-closed behind `CRON_SECRET`, and its scheduler is installed only after the authoritative migrations are deployed.

### D054: Authoritative control has a dedicated hot-path rate bucket

Reserve plus settlement requires at least two HTTP requests per paid operation, before bounded idempotent transport retries. Authoritative budget routes therefore use a per-key `budget_control` bucket of 600 requests per 60 seconds rather than the 100-per-minute dashboard/control-plane bucket. Every forwarded, authentication-failure, throttle, and route response is non-cacheable. This admission-control limit is isolated from telemetry and is not financial authority; PostgreSQL serialization remains authoritative if Redis rate limiting fails open.

### D055: Expiry scans are tenant-isolated and operationally bounded

Forced RLS prevents a safe cross-tenant scan of reservation rows. The expiry runner keyset-pages the unscoped parent builder identities in batches of at most 1,000, processes at most 25 builders concurrently, and expires at most 100 reservations per builder per invocation by default. Every builder enters a separate transaction-local tenant context. A tenant failure is isolated and logged using only an opaque builder reference and error class; partial progress returns success with an error count, while enumeration failure or failure of every scanned tenant returns 5xx so the scheduler retries and alerts.

### D056: Readiness ordering uses a lock-serialized authority sequence

Millisecond timestamps cannot prove whether a rule origin was created immediately before or after a readiness transition. Migration 051 therefore assigns every immutable rule revision an internal `authority_order` and assigns each ready cutover a `ready_order` from one non-cycling PostgreSQL sequence. Both values are allocated only after acquiring the same exclusive builder advisory lock, and caller-supplied values are overwritten. A stable rule is safely post-readiness only when its revision-zero origin order is greater than the cutover order; rotations never change that provenance. Sequence gaps from rollback are harmless. This distinguishes pre- and post-ready work even at the same server millisecond and prevents both fabricated zero openings and permanently stranded legitimate rules.

### D057: Exact-backfill authority is one process-start adapter across the lifecycle

Exact backfill is enabled only when one non-replaceable process-start adapter supplies both a retry-safe activation fence and later exact opening-balance resolution from the durable reconciled state installed by that fence. Readiness activation, capability reporting, and account materialization consult the same adapter identity. A ready database row without the adapter after a restart is advertised disabled and fails closed; missing subject evidence throws and never becomes an assumed zero. The adapter runs under the exclusive builder transaction and tenant RLS context, and replacing it in a live process is rejected so capability and materialization cannot observe different authorities.

### D058: PostgreSQL fixed-scale ceiling uses exact multiplication

The one-ceil rule from D051 is implemented as `ceil(exact_cost * 10^18) * 10^-18`, not division by `10^18`. PostgreSQL chooses a result scale for numeric division; at the 26-integer-digit v1 tool maximum, the division form discarded the fractional scale and conservatively but incorrectly rounded to a whole dollar. LLM per-million pricing likewise combines its `/ 10^6` conversion with attodollar scaling algebraically, multiplying the exact token-rate sum by `10^12` before the ceiling instead of dividing first and losing up to six fractional digits. Exact multiplication by `0.000000000000000001` then preserves all 18 public fractional digits. Maximum-boundary integrations pin both tool and LLM results, with tool cost and overage carried through the response, authoritative usage ledger, and outbox payload.

### D059: ClickHouse accepts authoritative cost only from the immutable outbox projector

The PostgreSQL cost-event outbox is the sole supported input to the authoritative ClickHouse table. The projector preserves the immutable builder, event, event-time, and payload-hash identity; its database principal is the only application principal with `INSERT`, while dashboards, billing readers, and ordinary application roles are read-only. ClickHouse retry collapse uses `(builder_id, timestamp, event_id, payload_hash)`, and the canonical view admits an event identity only when the hashes for its builder, timestamp, and event ID agree. Reconciliation additionally inspects builder/event identity across every timestamp, so a same-time hash conflict or cross-time duplicate never becomes verified and keeps billing closed. Arbitrary out-of-band writers are outside the supported trust boundary and must be prevented by deployment ACLs, not normalized into authority after the fact.

### D060: Authoritative projection has separate telemetry and billing retention

Content-bearing or diagnostic projection fields expire at the builder tier's telemetry horizon, while the stable typed cost fact survives through the longer billing horizon. The public analytics union hides an authoritative row after its telemetry horizon even if its billing fact remains physically retained. The billing-only canonical view continues to expose the exact decimal amount until billing retention expires. Reconciliation verification is required before PostgreSQL detail tombstoning, so retention cannot erase the only recoverable payload before the durable projection is proven.

### D061: Billing closure is serialized against lifecycle commits

Every lifecycle transaction acquires migration 050's shared builder advisory lock before reservation, account, or usage row locks. The billing projection gate acquires the matching exclusive lock before checking period closure and unverified outbox rows. An already-running settlement therefore commits its transactional outbox before the gate can return; a settlement queued behind the gate receives its PostgreSQL `committed_at` from `clock_timestamp()` only after the gate releases and is outside the earlier cutoff. Lock ordering is one-way: lifecycle takes the builder lock before row locks, while the gate takes only the builder lock and performs non-locking reads. Projection and reconciliation do not take the builder lock; under `READ COMMITTED`, an uncommitted verification can produce only a conservative false-negative, never an early billing success.

### D062: Definer owners retain only PostgreSQL's administrative creator edge

PostgreSQL 16 and 17 record an implicit creator-admin membership edge when a standard `CREATEROLE` migration principal creates a role. The grantor-owned edge cannot be removed reliably by that same migrator. The two fixed discovery owners therefore retain exactly that administrative edge to the safe migration role, with `admin_option = true`, `inherit_option = false`, and `set_option = false`. This is accepted because the migration credential already holds schema-owner and role-creation authority and is never an application credential. No runtime group or login may be the member, runtime `SET ROLE` must fail, the owners have no outbound memberships or other inbound edges, and migration replay must preserve the same posture. This explicit PostgreSQL portability exception replaces the stronger but unimplementable requirement for zero catalog edges under an ordinary `CREATEROLE` migrator.

### D063: Cross-tenant worker discovery is a narrow RLS capability

This supersedes D055's earlier all-builder enumeration design. Projection and expiry enumerate only distinct actionable builder UUIDs through separate `SECURITY DEFINER` functions. Each NOLOGIN, NOBYPASSRLS owner has column-level `SELECT`, an owner-specific permissive actionable policy, and an identical restrictive actionable ceiling; the function repeats that predicate, keyset-pages UUIDs, and caps a page at 1,000. The dedicated NOBYPASS runtime group receives only `EXECUTE` plus explicit authoritative-table verbs and the one authority sequence, with no membership path to either owner. Existing tenant policy can contribute a valid tenant row but cannot widen the restrictive actionable ceiling. Unset, pooled empty, malformed, and foreign tenant GUC states are hostile-test inputs; invalid GUC text must not become an availability dependency or a cross-tenant widening path.

### D064: Authoritative control uses a dedicated production database identity

The general Next.js `DATABASE_URL` remains unchanged because application authentication, bootstrap, and unrelated jobs still require their existing database surface. Every authoritative reservation, lifecycle mutation, rule revision, projection, and expiry transaction instead uses `BUDGET_CONTROL_DATABASE_URL`: a dedicated LOGIN whose only reachable non-self role is the fixed NOLOGIN, NOINHERIT, NOBYPASSRLS `pylva_budget_control_runtime` group. The login has no direct object ACLs, owns no protected object, and fails production readiness on any extra membership or privilege. `MIGRATION_DATABASE_URL` remains a separate offline object-owner/CREATEROLE credential and is rejected from the application runtime. Local and CI reuse requires an explicit non-production fallback switch; production never falls back.

### D065: Strict provider enforcement is an explicit integration surface

Automatic provider monkey-patching remains a backward-compatible legacy telemetry convenience. It cannot be a fail-closed authority because provider ESM loading can race, provider SDK methods return richer promise and stream objects, and internal retry/fallback attempts are otherwise invisible. SDK 1.2 therefore guarantees strict enforcement only through explicit `wrapOpenAI`/`wrapAnthropic` and `wrap_openai`/`wrap_anthropic` integration surfaces, plus an explicit Vercel AI controlled middleware/helper. These surfaces preserve the provider's documented promise, stream, iterator, and context-manager behavior while routing every possible paid dispatch through one reserve/dispatch/settle attempt primitive. Provider retries are disabled unless Pylva itself creates a separately authorized attempt.

### D066: “All-cost” means every cost in a documented, price-complete subset

The v1.0 control wire and current authoritative pricing snapshot represent base LLM input and output tokens. They do not represent cached-token writes/reads, audio, remote media tokenization, premium or batch tiers, hosted/server tools, or other provider-specific paid dimensions. SDK 1.2 must therefore refuse those features before dispatch in strict mode rather than silently under-price them or market unsupported coverage. The initial supported LLM subset is OpenAI Chat Completions and Anthropic Messages with text plus client-side function/tool schemas, one completion, an explicit maximum-output bound, standard service tier, no hidden provider retries, and no paid cache/server-tool/media component. Unknown or newly introduced paid fields are unsupported until the backend wire, pricing source, ledger, projection, dashboard, and both SDKs model and test them end to end.

### D067: Cache and tier evidence must prove base-token settlement

OpenAI prompt caching is automatic for eligible prompts and reports cache reads and writes separately; Anthropic reports cache creation/read tokens, server-tool usage, service tier, and long-context pricing evidence separately. A strict wrapper accepts an OpenAI request only when caching is explicitly disabled on a supported API shape or a conservative content-local bound proves the request below cache eligibility, and it requires a standard/default tier. Anthropic strict calls require `standard_only`, no cache markers or server tools, and a conservative bound below the premium long-context threshold. Settlement commits only when the response confirms the supported base-only usage shape. An unexpected paid component after dispatch is never converted to exact zero or released; the reservation remains unresolved for expiry and reconciliation. Prompts, tool arguments, messages, URLs, and content never enter a control request or diagnostic log.

### D068: TypeScript size budgets include the complete enforcement boundary

> Historical note: the measurements and numeric caps below belong to a superseded pre-hardening
> artifact. D088 replaces them while retaining this decision's complete-enforcement-boundary
> accounting principle.

The TypeScript OpenAI, Anthropic, and Vercel AI entry points each carry the authoritative control client, wire-schema validation, attempt ownership, fail-closed settlement, and provider-specific strict-subset validation needed to make the entry point safe in isolation. Their final measured minified gzip sizes are 23.09 KB, 23.31 KB, and 19.82 KB respectively, so the OpenAI and Anthropic caps increase from 20 KB to 25 KB while the Vercel AI cap intentionally remains a tight 20 KB hard gate; any further Vercel AI growth requires review. The strict provider bundles grew after exact LangGraph callback ownership and cross-entrypoint SDK identity were made artifact-correct: each standalone bundle retains its enforcement boundary while converging on the same versioned private process runtime, and removing that runtime would break clean installed-package correlation and reinitialization correctness. Required root exports for those strict integrations, exact non-LLM control, Tavily, and ownership correlation increase the root bundle from 22.39 KB to 33.68 KB; its cap therefore increases from 23 KB to 35 KB. The final LangGraph callback bundle is 10.02 KB and retains its 15 KB cap. Keeping the APIs subpath-only was rejected because standalone bundles have independent configuration, control-ownership, and telemetry state, while SDK 1.2 requires one correct root singleton and public root API. Enabling bundle splitting increased the earlier measured wrapper entry-point totals to 23.11 KB, 23.34 KB, and 20.05 KB and conflicted with the package's `sideEffects: false` contract by making generated bare chunk imports removable. These are measured allowances for enforcement and the required public surface, not permission to omit validation or native provider behavior.

### D069: D059 uses an exact ClickHouse role closure and bounded continuous attestation

ClickHouse 24.8 implements neither `SHOW GRANTS FINAL` nor `CHECK GRANT`, so the D059 projector boundary is proven without either statement. Each application connection must report exactly its one fixed role from `currentRoles()`, `enabledRoles()`, and `defaultRoles()`; its direct `SHOW GRANTS` output must contain only that role assignment; and `SHOW GRANTS FOR <fixed_role>` must exactly match the fixed positive grant contract. A separate provisioning admin runs an idempotent catalog audit in every deployed access-control scope, revokes authoritative `INSERT` from all other users and roles, and requires the only remaining writers to be the fixed projector role plus the explicitly named break-glass admin. The projector role may be assigned directly and by default only to the projector user, with no nested role or admin option. Production projector, general, and provisioning URLs use distinct non-default, password-bearing principals over HTTPS; plain HTTP has no production escape hatch. Runtime failures are not cached and therefore recover on the next worker use after an operator repairs grants. A successful exact-role attestation **must** authorize use for no more than five seconds end to end without adding an attestation round trip to every projected event. The current nested client/posture caches can extend that window to almost ten seconds and do not yet meet this decision; D102 records the required regression. This refines D059's deployment-ACL requirement; PostgreSQL remains the authority and the admin-level global writer audit remains a predeployment and post-grant-change gate.

### D070: Every ClickHouse time boundary is parsed explicitly as UTC

`chTimestamp` emits UTC wall-clock text, but a ClickHouse `{value:DateTime}` query parameter interprets that text in the server's configured timezone. A non-UTC server can therefore omit newly projected rows, shift a reconciliation window, or paginate a cursor at the wrong instant even though the application supplied a UTC `Date`. Every runtime ClickHouse time bound, cutoff, and cursor must be bound as `String` and converted with `parseDateTime64BestEffort(..., 3, 'UTC')`; date-only bounds must derive from that same explicit UTC instant. The canonical mixed view normalizes legacy and authoritative timestamps to `DateTime64(3, 'UTC')`. A repository contract rejects native `DateTime` placeholders anywhere under `src`, and the real dashboard journey runs against a non-UTC ClickHouse server to prove fresh authoritative costs remain visible. Daily pricing reconciliation still uses a date-only cast that can promote through the server timezone and does not yet meet this decision; D103 records the required fix and service test.

### D071: Raw authoritative JSONB writes do not depend on mutable driver serializers

Drizzle mutates the shared postgres.js client's JSON/JSONB serializers for its own pre-serialized values. A raw tagged-template caller that binds a JavaScript object or pre-serialized string directly to `::JSONB` can therefore fail before PostgreSQL sees the query or store a JSON string instead of the intended object. Every production authoritative raw binding uses validated plain JSON text followed by `::TEXT::JSONB`; rule create/update applies the same boundary before atomically reconciling its immutable revision. The strict text serializer rejects cycles, accessors, sparse arrays, symbols, non-finite numbers, exotic prototypes, and excessive depth or node count. A real shared-client PostgreSQL regression creates and updates both ordinary and authoritative rules, verifies exact object configuration and revision hashes, and proves rollback, retry, and atomic history behavior. This is a transport boundary only: PostgreSQL canonical JSONB text remains the source used for stored hashes and replay equality.

### D072: LangGraph callback ownership is exact across dispatch and refusal

LangGraph/LangChain callbacks are observers, not a second billing authority. A public per-invocation control scope creates an async-safe rendezvous between one callback start and one explicit strict LLM wrapper or controlled-tool helper. Callback-first dispatch links the exact operation, reservation, trace, span, customer, pricing identity, and SDK identity generation; provider-first dispatch captures the one active operation directly. A pre-dispatch authoritative denial or local pre-dispatch refusal links exact no-dispatch ownership before rethrowing, so the matching LangChain error callback does not fabricate a paid failure event. Zero or multiple pending same-kind callbacks are ambiguous: the SDK warns, never guesses by name, model, metadata, elapsed time, or proximity, and leaves callback telemetry unsuppressed. The scope correlates ownership only; it does not initialize Pylva, patch a provider, or enable enforcement. Because TypeScript root and LangGraph entrypoints are intentionally standalone bundles, they share a versioned private process runtime for configuration identity, resetters, tracking context, and correlation storage. An identity change through any entrypoint synchronously clears every bundle's old-tenant state before installing the new identity. Clean built-artifact StateGraph journeys in both SDKs must commit one exact LLM and one exact tool, refuse the next paid node before its closure runs, produce no duplicate legacy event, and close against the real HTTP service, PostgreSQL ledger, and outbox.

### D073: Strict routing and fallback are caller-owned attempts

SDK 1.2 strict integrations do not invoke the legacy automatic model-routing or cross-provider failover engine. The provider and model supplied to an explicit strict call are the final priceable identity for that attempt, and provider-native retries are disabled. If an application routes or falls back, it must invoke a separately wrapped provider call; that call receives a fresh operation identity and an independent reservation for its actual provider and model. A failed attempt's reservation is never reused to authorize a differently priced action. The legacy routing/failover engine remains telemetry-only and is outside the strict no-spend guarantee. Both SDKs pin this boundary with regressions that execute distinct primary and fallback attempts and assert distinct actual provider/model reservation identities.

### D074: Tavily one-credit control rejects locked-option aliases before reservation

The first official Tavily Search adapter is price-complete only for basic search with automatic parameters disabled and exact provider usage evidence enabled. Official provider SDKs accept passthrough keyword arguments after their native mapped fields, so an alternate spelling of a locked option can otherwise override the adapter's bound. TypeScript therefore rejects `search_depth`, `auto_parameters`, and `include_usage` aliases, while Python rejects the cross-case `searchDepth`, `autoParameters`, and `includeUsage` aliases, before either reservation or provider invocation. Both facades force their native basic/false/true option shape. This prevents a one-credit reservation from dispatching an advanced or automatically upgraded two-credit search, and prevents suppression of the usage evidence required for exact settlement. Additional Tavily modes require a separately documented conservative bound and settlement contract.

### D075: Production store posture is independent of new-reservation enablement

`ENABLE_AUTHORITATIVE_BUDGET_CONTROL=false` prevents new authoritative reservations but does not
restore the old data-store boundary. Rule mutations already write their immutable revisions through
the dedicated PostgreSQL identity, and settlement, expiry, and projection must continue draining work
created before the flag changed. Every production process therefore attests the isolated
`BUDGET_CONTROL_DATABASE_URL` login and the exact ClickHouse general/projector roles during runtime
bootstrap even while new reservations are disabled. A missing or unsafe identity prevents a healthy
production start with a sanitized posture reason. Local and test processes retain their explicit
fallback behavior. This closes the configuration state in which an image could report its general
stores healthy but return `credential_missing` for every rule write or strand authoritative work.

### D076: CI bootstraps an ordinary migration owner and preserves single-database runtime ACL closure

Official PostgreSQL service containers initially expose the configured bootstrap login as a
superuser, while migration 052 intentionally requires an ordinary database-owning `CREATEROLE`
principal. Every service-backed CI job therefore uses a CI-only admin bootstrap to create and
strictly attest the fixed `pylva_migration_ci` login, transfer the disposable target database to it,
and run `db:setup` through its separate `MIGRATION_DATABASE_URL`. The migration role is `LOGIN`,
`INHERIT`, `CREATEDB`, and `CREATEROLE`, but `NOSUPERUSER`, `NOREPLICATION`, and `NOBYPASSRLS`. The
container admin is confined to that disposable bootstrap. After migration 054, every service-backed
application job uses a separately provisioned ordinary non-super general login for `DATABASE_URL`,
while authoritative runtime work uses the dedicated, narrowly privileged budget login. Scratch
database lifecycle uses the explicit test-only `PYLVA_TEST_DATABASE_ADMIN_URL` pointed at the
migrator instead of repurposing either runtime URL. This bootstrap is disposable CI topology, not a
production self-provisioning path.

PostgreSQL roles and database ACLs are cluster-wide, and runtime posture deliberately permits
`pylva_budget_control_runtime` exactly one direct database privilege: `CONNECT` on the current
database. The scratch migration-runner and runtime-role contract therefore execute after migration
role bootstrap but before the main database is migrated. Dropping their scratch databases removes
their temporary database ACLs; main `db:setup` then installs the budget group's sole final CONNECT
grant, while migration 054 separately installs and attests the exact general-app group contract.
Post-migration broad suites do not rerun those pristine-cluster contracts. CI preserves the
production invariant instead of weakening attestation for test convenience.

### D077: Legacy owner bootstrap and authoritative FORCE RLS are separate boundaries

Migration 046 documents that the general application still connects as the owner of `builders`,
`rules`, `cost_sources`, and `custom_pricing`, and that authentication/bootstrap paths reach those
catalogs before an `app.builder_id` tenant GUC exists. Migration 052 correctly made the dedicated
budget runtime a narrowly privileged NOBYPASSRLS non-owner, but also FORCEd those four legacy tables;
that subjected the existing owner path to policies that intentionally expose no row before tenant
context. Frozen migrations 050–052 remain byte-identical. Forward-only migration 053 keeps RLS
enabled but applies `NO FORCE ROW LEVEL SECURITY` to exactly those four legacy catalogs. The nine
authoritative/control tables remain FORCEd.

This is a compatibility boundary, not a reduction of the dedicated runtime boundary. Runtime
attestation retains all 13 relations in its protected ownership and completeness sets, requires RLS
enabled on all 13, requires FORCE on exactly the nine authority tables, and requires NO FORCE on
exactly the four legacy owner catalogs. The dedicated login and every reachable role must own none
of them, so ordinary RLS continues to isolate its legacy-catalog reads and writes. A real PostgreSQL
regression pins a NOSUPER/NOBYPASS table owner's pre-GUC bootstrap CRUD, the dedicated runtime's
cross-tenant refusal, and the 9-FORCE/4-NO-FORCE physical posture. A future general-application
non-owner role with complete tenant-context coverage may replace this compatibility exception only
with its own migration and end-to-end authentication/bootstrap evidence.

### D078: The general application uses a fixed temporary owner boundary, not migration authority

Migration 053's `NO FORCE ROW LEVEL SECURITY` compatibility is insufficient when a separate
`MIGRATION_DATABASE_URL` owns a fresh schema: an ordinary `DATABASE_URL` login is still a non-owner,
and migration 052 removed ambient PUBLIC table, sequence, and schema-creation access. Migration 054
therefore creates the fixed `pylva_general_app_runtime` role as
`NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION` and normalizes one
closed legacy ownership surface to it. The request-serving login is a separate ordinary
`LOGIN INHERIT` principal with no dangerous role attributes. It receives exactly one outbound
membership edge to the fixed group with `ADMIN FALSE`, `INHERIT TRUE`, and `SET FALSE`; it cannot
assume the role explicitly, administer its membership, inherit the migrator, or reach the
authoritative budget runtime.

The relation ownership allowlist is exactly `alert_history`, `anomaly_events`, `api_key_vault`,
`api_keys`, `audit_log`, `builder_alert_config`, `builder_feature_flags`, `builders`, `cost_sources`,
`custom_pricing`, `custom_rule_requests`, `customer_pricing`, `customers`,
`feature_flag_overrides`, `invites`, `invoice_idempotency`, `invoices`, `llm_pricing`,
`portal_access_grants`, `portal_configs`, `portal_domains`, `portal_links`, `portal_sessions`,
`pricing_onboarding_tasks`, `pricing_sync_log`, `rule_alert_channels`, `rule_events`, `rules`,
`stripe_connect`, `stripe_connect_event_log`, `user_builder_memberships`, `users`,
`webhook_configs`, and `webhook_dlq`, plus only the current children of the allowlisted `audit_log`
parent. Future audit children enter the ownership set only when the bounded function below creates
them as partitions of that exact parent and as the fixed group; no name wildcard or unrelated child
is accepted. The same owner group holds the `webhook_configs_with_grace` view, the
`api_key_vault_id_seq`, `audit_log_id_seq`, and `llm_pricing_id_seq` sequences, and
`generate_slug(text)`. It receives read-only migration-head visibility but does not own the migration
ledger or migration-only backup.

The group also owns `pylva_ensure_audit_log_partition(date)`, a `SECURITY DEFINER` routine that
derives the partition name from a validated UTC calendar-month input, accepts only the current UTC
month through twelve months ahead, serializes concurrent creation, rejects collisions or mismatched
ownership/bounds, and has no PUBLIC execution grant. The resulting `TIMESTAMPTZ` bound instants are
not forced to UTC: migration 054 captures the historical migration time zone from the applying
session and pins it on the function so new partitions continue the frozen migration runway without
gaps or overlaps. Existing bounds must match that interpretation or migration fails closed; an
upgrade operator must therefore use the same time zone that created the existing runway. The daily
route calls this routine instead of constructing DDL from request input. This bounded function is
part of the bridge; it does not turn the general login into a migration credential.

All nine authoritative/control tables, `pylva_budget_authority_order_seq`, authority routines, and
their ACLs remain outside the general owner boundary. Authoritative reserve, lifecycle, rule,
projection, and expiry work continues through the separate `BUDGET_CONTROL_DATABASE_URL` login and
fixed budget runtime role. Schema changes continue through the separate migration principal. The
migrator retains only its PostgreSQL-required non-inheriting ADMIN-only edge and a separate
non-inheriting SET-only edge to the owner group; ordinary migration queries do not inherit owner
rights.

PostgreSQL 16 and 17 also add one implicit reverse creator edge when the `CREATEROLE` migrator creates
the application LOGIN: the application role is granted to the migrator with `ADMIN TRUE`,
`INHERIT FALSE`, and `SET FALSE`. The ordinary migrator cannot reliably remove that catalog edge. It
is accepted because it conveys no application or inherited owner privilege and the migrator already
has offline role-administration authority. This creator-admin edge is the only permitted member of
the application role; any other descendant, or any reverse edge with INHERIT or SET, fails closed.
The application login still has no path to migrator privileges.

This is deliberately a temporary compatibility bridge. It preserves pre-tenant authentication,
API-key, bootstrap, and legacy job behavior, including legacy owner bypass and schema `CREATE`,
while separating request traffic from the migration credential. Migration 054 fails closed if the
migrator cannot normalize every allowlisted object's existing ownership; operators must repair that
ownership path before retrying, never promote the application login. The target design remains a
fully non-owner general application with exact ACLs, complete tenant context, FORCE RLS where
appropriate, and additional narrowly bounded definer routines for the few maintenance operations
that genuinely require owner authority. A future forward-only migration and end-to-end auth/job
evidence must complete that transition.

### D079: Budget-runtime login provisioning is transactional and owner-scoped

Migration 054 divides the public schema between the migrator and the fixed general-application owner
group. PostgreSQL permits only an object owner (or superuser) to revoke an existing object ACL, so a
single migrator-issued `REVOKE ... ON ALL TABLES` cannot safely repair a drifted budget-runtime login
after that migration. The provisioner enumerates only public relations, sequences, and column ACLs
owned by the current role, performs that cleanup first as the migrator and then under the migrator's
sealed `SET ROLE pylva_general_app_runtime` edge, and never uses a name wildcard as an ownership
substitute.

Runtime-login creation, password rotation, role-setting reset, outgoing-membership replacement,
owner-scoped ACL cleanup, current-database `CONNECT`, fixed-group grant, and the complete postcondition
run in one PostgreSQL transaction. A failed role switch, revoke, grant, or attestation therefore
restores the previous login rather than leaving a partially repaired identity. Protected attributes
and direct routine grants that an ordinary `CREATEROLE` migrator cannot safely repair are rejected
before mutation. The final attestation requires exact login and group attributes, exactly the one
inherited/settable runtime-group edge, the one safe reverse creator-admin edge, a two-role reachability
closure, no ownership anywhere in `pg_shdepend`, no default/object/column/routine/schema ACLs, and one
non-grantable `CONNECT` privilege on the current database. Real PostgreSQL adversarial tests prove
two-owner repair, hostile third-owner rejection, missing general-owner `SET` rejection, and full
transaction rollback.

### D080: Standalone TypeScript entrypoints share catch-path identity through a private v1 runtime

> Final-candidate note: the process-global-symbol implementation described below did not survive the
> final privacy and control-integrity review. It exposed secret-bearing configuration and mutable
> enforcement registries to ordinary process-global reflection. This entry is retained as historical
> rationale only and must be superseded by a physically shared, closure-owned runtime decision before
> SDK artifacts are accepted.

The npm package intentionally builds root, provider, Vercel AI, and LangGraph entrypoints as
standalone bundles. Module-local `WeakMap` and error classes therefore made a root auto-patch
invisible to a strict provider subpath and made `instanceof` depend on which entrypoint constructed an
error. Generated shared chunks were rejected earlier because they weaken the package's independent
entrypoint and tree-shaking contract.

Every standalone bundle now rendezvouses through versioned, non-enumerable process-global symbols.
One private registry canonicalizes all five public catch-path constructors: budget exceeded, control
unavailable, control API, control validation, and strict-provider errors. A separate process-global
`WeakMap` preserves original-to-patched provider function identity across root and strict subpaths.
The public interface-plus-constructor exports remain both type and value compatible; error names,
codes, fields, prototypes, and messages are unchanged. Installed ESM and CJS smoke tests cover both
root-first and subpath-first import orders with official OpenAI and Anthropic packages, real wrapper
dispatch, reinitialization, opaque-patch refusal, and root-side `instanceof` checks.

### D081: Legacy ClickHouse event storage is pinned to UTC as well as its query boundaries

D070 made every runtime range, cursor, and cutoff parse its application-supplied text explicitly as
UTC, but legacy `cost_events.timestamp` was still a bare `DateTime`. The ingest path serializes a
JavaScript UTC instant as timezone-free `YYYY-MM-DD HH:MM:SS`; a ClickHouse server or session in
`Asia/Riyadh` interpreted that text as local time and stored an epoch three hours earlier. Canonical
UTC dashboard queries could consequently miss a freshly ingested row even though their own bounds
were correct.

Fresh schema 001 now declares `DateTime('UTC')`, and forward-only ClickHouse migration 012 modifies
existing `cost_events.timestamp` to that exact type. ClickHouse stores `DateTime` as epoch seconds, so
the type-only timezone annotation preserves existing instants while making future timezone-free
inserts deterministic. Readiness rejects the stale bare type, and the remaining legacy
`parseDateTimeBestEffort` clauses pass an explicit `UTC` argument. A real isolated non-UTC upgrade
applies every migration through 011 with the historical bare type and all materialized views, proves
the old epoch is byte-for-byte unchanged across 012, inserts a new event under `Asia/Riyadh`, and
proves the correct UTC epoch is visible through the canonical `DateTime64(3, 'UTC')` view.

That storage proof passed locally on ClickHouse 26.5. The declared 24.8 floor remains pending remote
CI evidence, and D103's separate date-only reconciliation blocker means UTC query closure is not yet
complete.

### D082: Provider settlement accepts only explicit base-price evidence and zero-valued extensions

A provider can add response usage fields independently of the request shape. Treating an unfamiliar
counter as absent can commit a base-token price even when audio, cache creation, server tools, or a
new premium component was charged. Both SDKs therefore inspect the complete supported response
usage shape rather than extracting only input and output tokens. Documented base-inclusive counters
and explicitly nonbilling metadata are accepted; separately priced counters must be exactly zero;
and an unknown additive field is accepted only when its complete bounded value is zero. Any unknown
nonzero, malformed, cyclic, excessively large, or getter-hostile evidence makes the result inexact.

This rule covers OpenAI prompt/completion detail fields, Anthropic cache creation/read and server-tool
usage, and Vercel AI's unified usage, raw usage, and provider metadata. It applies equally to sync,
async, and stream terminal evidence. Once provider dispatch has occurred, inexact evidence never
replaces or rejects the successful native result and never releases the hold; the reservation stays
unresolved for expiry and reconciliation, with no authoritative commit fabricated from a partial
price. Expanding a paid response field from zero to a priced value requires end-to-end wire, pricing,
ledger, projection, dashboard, and cross-SDK support rather than a wrapper-only allowlist change.

### D083: Local pre-dispatch refusals use exact callback rendezvous without stealing a real attempt

Strict request validation, client/retry validation, generic controlled-tool validation, and the
locked Tavily facade can refuse locally before a reservation or provider-attempt context exists.
LangChain has already started its callback at that point; without an explicit rendezvous, its later
error callback can fabricate a legacy paid-failure event for an operation whose provider/tool count
is zero. Each SDK now links one same-kind, same-configuration pending callback to an internal
no-dispatch marker before rethrowing the original local error.

The marker is observer-only and does not become authority, reserve capacity, or enter public billing
telemetry. It links only when exactly one eligible callback is pending. Multiple candidates remain
ambiguous, warn once, and are not suppressed. A real attempt created after reservation owns its
callback through the existing operation/reservation/trace/span identity and cannot be replaced by a
later local marker; inherited outer operations cannot steal nested callbacks. Focused Python and
TypeScript regressions cover strict OpenAI/Anthropic/Vercel validation, exact and bounded generic
tools, Tavily, authoritative denial, nested/post-reservation failure, ambiguity, and zero provider or
tool invocation.

### D084: Dashboard authority reads use the budget runtime, never the general application owner

Budget activity and budget-account state read the authoritative ledger. Routing those queries
through the ordinary general-application `withRLS` pool violates the role boundary: that login is
correctly denied every authority table, so a production-shaped dashboard receives SQLSTATE `42501`
even if owner-backed unit fixtures pass. Granting authority-table reads to the general role was
rejected because it would widen the request-serving credential and invalidate the isolated budget
runtime posture.

The public read-model wrappers now execute through a minimal `withBudgetControlReadTransaction`
adapter. It obtains the attested dedicated budget client, opens the existing bounded transaction,
sets `app.builder_id` with transaction-local parameterized configuration, compiles Drizzle SQL with
its PostgreSQL dialect, and executes the resulting SQL and encoded parameters on that same private
transaction. The adapter exposes no general client and no mutation convenience surface. Source
boundary tests forbid returning to `withRLS`; a real ordinary-login test proves direct authority
access fails with `42501` while both public read models succeed for the scoped tenant; and the
authenticated desktop/mobile journey proves the blocked-only trace and zero-cost end user render
through the production credential topology.

That closure applies to Budget Activity and account-state read models. The Cost Sources page still
issues authority queries through general `withRLS`; it does not yet meet D084. D101 records the
required split-query correction and production-shaped coverage.

### D085: Strict Vercel AI control is an asynchronous AI SDK 6.x consumer-lifecycle contract

> Final-candidate note: the consumer-lifecycle rules below remain valid, but accepting a
> caller-created provider model is superseded. The frozen source contract now uses an asynchronous
> `createControlledOpenAIChatModel({ apiKey, model })` factory and an opaque managed token. D087 binds
> that contract to the physically canonical cross-ESM/CJS artifact runtime.

The v1.2 strict Vercel helpers support the official OpenAI Chat provider on AI SDK major 6 only.
`controlledGenerateText` and `controlledStreamText` validate that version and the price-complete
request subset before provider I/O, then await an authoritative reservation before dispatch. The
stream helper therefore intentionally returns a promise even though native `streamText` is
synchronous. A different AI SDK major, an OpenAI Responses model, a custom transport, or the Vercel
Anthropic provider is refused before dispatch rather than accepted under an unverified compatibility
or pricing assumption.

The strict wrapper preserves the native result identity and prototype while observing the consumer's
`textStream`, `fullStream`, `partialOutputStream`, and `toUIMessageStream` views. Lease heartbeat
starts on the first actual pull or provider chunk, not merely when the result is returned. Only one
supported terminal finish carrying bounded, internally consistent, exact usage evidence can commit.
Missing, malformed, unknown nonzero, or otherwise inexact evidence preserves the provider result and
leaves the reservation unresolved; it never fabricates a base-only charge or releases a dispatched
attempt.

Caller abort, reader cancellation, iterator return, pipe failure, native read rejection, and
consumer callback failure stop the heartbeat, detach the caller signal, and abort the provider at
most once while preserving the native consumer-visible result or error. They do not commit or release
after dispatch. A literal consumer-visible EOF without the provider's finish callback performs the
same lease cleanup but cannot invent settlement evidence. These guarantees apply at the observed
consumer boundary because relying only on provider callbacks misses early-return and stalled-stream
paths that still own reserved capacity.

### D086: Direct strict providers dispatch only through private official clients

A caller-owned OpenAI or Anthropic client is mutable across the asynchronous reservation boundary.
Even when its endpoint, retry count, headers, query, and transport look safe at wrap time, later
mutation of that client or its resource can redirect the paid call or invalidate the price evidence.
The public TypeScript wrappers are therefore asynchronous and accept an exact supported official
client only as a validated credential/configuration carrier. Python applies the equivalent exact
sync/async official-client and default-transport identity checks. Both SDKs read credentials only
after official identity and default-transport provenance pass, construct a separate private official
client with the canonical provider endpoint and retries disabled, and dispatch through a captured
private low-level method. The returned narrow facade exposes only the supported create, stream, and
close surfaces; it never returns the private client, credentials, resource, transport, or an unwrap
capability.

Every complete request is descriptor-snapshotted into bounded built-in JSON containers before any
reservation await. Accessors, proxies, symbols, sparse/custom arrays, custom mappings/classes,
cycles, shared graphs, unsafe numbers, excessive depth/size, unknown paid fields, and mutable
serialization hooks are rejected before control or provider I/O. The exact live abort signal is the
only deliberate retained caller reference. Closing a facade is idempotent and establishes a second
pre-dispatch barrier: close-before-call refuses locally, while close during reservation releases an
owned hold exactly once and records the matching no-dispatch correlation. The precise guarantee is
no provider network dispatch or spend and no commit: source linearization may already have entered a
captured private provider method, but the closed official transport must make zero HTTP requests.
Once network dispatch begins, ambiguous provider/consumer outcomes retain the hold for authoritative
replay, expiry, or reconciliation rather than guessing a release.

The supported TypeScript provider range is OpenAI 4.104.0 through 5.x and Anthropic 0.30.1 through
pre-1.0; both the declared floors and repository-current versions must pass exact official-package
tests with unhandled network requests rejected. Python currently declares OpenAI 2.45 through 2.x
and Anthropic 0.116 through pre-1.0, and validates both wheel and sdist installations against the
floor/current resolver legs. Structural fakes remain available only through source-internal test
seams; public wrappers never relax official identity to make tests or custom transports convenient.

### D087: TypeScript entrypoints share physically canonical package-private runtimes

This supersedes D080's rejected process-global-symbol design. Independently importable root,
provider, Vercel AI, and LangGraph entrypoints do not own independent enforcement state. The package
`imports` map resolves every stateful or enforcement-sensitive domain to one physical, closure-owned
CJS runtime: configuration identity, execution and callback correlation, public error constructors,
strict control transport and attempt lifecycle, telemetry, budgets, routing, non-LLM policy, usage
snapshots, initialization validation, and strict unwrapping. Provider entrypoints likewise converge
on their one physical CJS implementation, while public ESM files are deliberately thin bridges to
the corresponding canonical CJS entrypoint.

No Pylva credential, configuration object, mutable registry, constructor table, managed-provider
token, reset capability, or patch-ownership map is published through `globalThis` or a process-global
symbol. Public and package-private CJS exports are frozen, and every completed package-local CJS
cache record reached by a public entrypoint is locked against deletion or replacement. Test resetters
and private control capabilities are absent from the published artifact. Reinitialization advances
one canonical generation and clears old-identity state before installing the new identity.

Root, deep, ESM, and CJS imports must therefore observe identical configuration generations,
catch-path constructors, provider function identities, callback correlation, and settlement
ownership regardless of import order. Installed-package tests must prove those identities in both
root-first and subpath-first order, reject peer-cache poisoning, detect any process-global mutation,
and verify that neither package exports nor completed package-local cache records can be replaced.
Generated shared ESM chunks remain rejected: package-private CJS mappings give one physical runtime
without creating removable bare side-effect imports under the package's `sideEffects: false`
contract.

### D088: TypeScript budgets use the hardened artifact's complete runtime closure

D068's pre-hardening measurements and numeric caps are superseded, but its accounting boundary is
not weakened. The release gate still follows every package-private mapping, relative edge, static
import/export, literal `require`, and literal dynamic import reachable from each public entrypoint.
It measures the dependency-first union of the physical CJS implementation and ESM bridge once with
level-9 gzip. Deferred code remains part of the size and trust boundary. Source maps are validated
but are not executable bytes, and declared optional peers remain user-supplied dependencies rather
than bundled Pylva runtime.

The hardened candidate adds descriptor-safe request snapshots, private official-provider clients,
one canonical authenticated control transport, exact consumer cancellation and close barriers,
package-cache tamper resistance, embedded path-safe source maps, and the D087 closure-owned runtime.
Exhaustive audits found no semantics-preserving root cleanup large enough to retain the old 35,000
byte assumption: removing every provably unused private export saved only 191 bytes; sharing provider
factories made closures larger; and even deleting a whole required public feature saved less than
3.4 KB. Lazy loading was rejected as size accounting because the complete code remains reachable,
and removing root provider behavior would be a breaking SDK-major change.

For this rebaseline only, each fixed cap is the candidate baseline plus the same approximately four
percent release headroom previously accepted for D068's root, rounded upward to the next 100 bytes:

```text
cap = 100 × ceil((baseline × 1.04) / 100)
```

| Entrypoint | Final D094 baseline (gzip-once bytes) | Fixed cap (bytes) |
| ---------- | ------------------------------------: | ----------------: |
| Root       |                                49,045 |            49,700 |
| OpenAI     |                                25,367 |            25,900 |
| Anthropic  |                                25,392 |            25,900 |
| Vercel AI  |                                20,184 |            21,000 |
| LangGraph  |                                15,051 |            15,700 |

These values are stored as constants. CI must never derive a new allowance from the build being
tested, and any future increase requires a new decision record. The final local tarball in D089
reproduces the five baselines, file closures, raw totals, and fixed margins. Remote CI and any release
candidate must consume those same bytes before this becomes external release evidence. This budget
describes distributed Pylva runtime and attack surface; it is not a claim about package download
size, resident memory, or cold-start latency.

D094's consumer-lifecycle closure supersedes the pre-fix measurements of 47,780, 24,848, and 24,878
bytes for root, OpenAI, and Anthropic. The Vercel AI and LangGraph closures are unchanged. The fixed
caps do not move: the final post-fix values still fit with 655, 533, 508, 816, and 649 bytes of
headroom respectively. This is intentionally tight evidence for the required fix, not a new
self-adjusting allowance.

## 2026-07-15 — Final-validation artifact and runtime decisions

### D089: One hash-addressed TypeScript tarball is the local release evidence unit

One npm tarball, addressed by SHA-256, is the TypeScript local release-evidence unit. Package
topology, embedded source maps, optional-peer-free loading, the strict floor and current peer
profiles, unsupported AI SDK refusal profiles, bundle budgets, and service-backed integration must
consume those exact bytes. No downstream gate may rebuild or repack the SDK and still claim evidence
for that hash. Package name and version continue to come from the packed metadata; the digest
identifies a candidate, not a published release, tag, merged commit, or deployed version.

The post-fix runtime candidate has SHA-256
`9f5459dda95f962f8f6567ee5580e36a87172f498ec8e1bbed321ad10e6e560f`. It was built and packed once;
the exact same bytes passed package topology and source maps, optional-peer-free loading, floor and
current strict peers, AI SDK 3/4/5 refusal, official ESM/CJS/mixed streams, cancellation and close,
cache-poison and identity checks, and D088's fixed size caps. The outside-workspace current-peer
install was attested, and the tarball rehash remained unchanged after those package gates. D099
supersedes this digest as release evidence because a later package-documentation audit found that
its embedded README did not match the final source README.

The earlier tarball with SHA-256
`428ce1e4462c495fb3f6585098680eff7d562230ee650fc580b9e9e44118832d` proved the process for the
pre-fix candidate, but is explicitly superseded. A later final diff audit found a post-dispatch
native-abort path that could leave its reservation heartbeat running. That digest is historical
evidence only and is not eligible for publication or final release-readiness attestation.

Artifact containment checks use canonical filesystem identity without confusing a path alias for a
different file. On macOS, for example, `/tmp` and `/private/tmp` can identify the same location. A
metadata output that does not exist yet is checked by canonicalizing its existing parent and then
reconstructing the filename; a requested attestation path is first proven to be inside the requested
install root and is then reconstructed below the canonical created root. The tarball, installed SDK,
and installed peers are still resolved with `realpath`, must remain outside the workspace where
required, and the tarball hash is checked before and after installation. Canonicalization removes
false alias failures; it does not relax sibling, containment, symlink, or immutable-hash boundaries.

### D090: The TypeScript floor is the lowest mutually installable strict peer closure

A peer matrix is executable evidence only when its complete dependency graph can be installed. The
strict floor therefore pins OpenAI 4.104.0, Anthropic 0.30.1, AI SDK 6.0.0,
`@ai-sdk/openai` 3.0.0, LangGraph 1.0.0, and `@langchain/core` 1.1.48. Core 1.0.0 is not a valid
direct floor for that graph because LangGraph 1.0.0 resolves a checkpoint dependency that requires
`@langchain/core` `^1.1.48`. This does not narrow the declared `>=1 <2` peer range; it records the
lowest mutually installable strict test profile instead of advertising an impossible set of
independently minimal versions.

Older supported official provider packages also need their provider-supplied web-runtime shims
selected before the provider and Pylva entrypoints are imported in the installed-package harness.
The floor/current harness activates the official OpenAI web shim for supported OpenAI 4.x packages
and the official Anthropic web shim for Anthropic 0.30.1 in every exercised ESM, CJS, and mixed
module path. Network responses remain deterministic and unhandled egress remains rejected, but the
official clients, request serializers, stream parsers, cancellation, and close behavior stay in the
test path. Structural provider fakes or a Pylva-owned replacement shim are not acceptable substitutes
for supported-floor artifact evidence.

### D091: Provisioning never repurposes a PostgreSQL group identity as the general-app login

The fixed `pylva_general_app_runtime` owner group and the request-serving general-app login are
different security identities, even if PostgreSQL could technically change a role's `LOGIN`
attribute. The provisioner rejects the fixed owner name as a target and rejects any pre-existing
target role with `NOLOGIN`; it must not convert an unknown group, ownership principal, or inherited
capability boundary into the application login. A safely bounded existing `LOGIN` may be repaired
transactionally, including its password, ordinary attributes, settings, memberships, and owner-
scoped ACL drift, but protected attributes, ownership, unsafe descendants, hostile third-owner ACLs,
or an unexpected identity shape fail before mutation.

This sharpens D078's separation and D079's transactional posture. It prevents an idempotent rerun
from changing what a durable role _means_ merely because the requested username collides with an
existing role. The ordinary login remains distinct from both the migrator and the fixed owner group;
the fixed group remains `NOLOGIN`, and the application reaches it only through the exact bounded
membership edge already recorded in D078.

### D092: LangGraph artifact proof dispatches through installed official provider clients

The clean-artifact LangGraph journey is not allowed to substitute a hand-shaped provider client for
the integration Pylva publicly wraps. TypeScript resolves the official OpenAI peer from the same
attested outside-workspace install as the immutable Pylva tarball. Python imports OpenAI 2.45.0 from
the same clean environment as the installed Pylva wheel. Both construct the supported official
client, dispatch the controlled chat-completions request through its real serializer and response
parser, intercept only the external provider transport deterministically, and reject unexpected
network escape. Artifact paths and versions are reported to the parent test so a source-tree import
or ambient provider package cannot satisfy the gate.

Controlled identity is proven at the boundary that durably owns it. The TypeScript official client
defers its fetch, so the wrapper's synchronous dispatch context is intentionally gone by the time the
mocked provider transport runs; provider-time inspection of an ephemeral current-attempt context
would be a false requirement. The runner instead captures the exact operation ID from the actual
authoritative reservation request and the reservation ID from a cloned successful reservation
response, then reconciles both with the PostgreSQL ledger. Python's synchronous provider and tool
closures can additionally observe their exact active attempt. Neither path guesses identity from a
model name, graph node, timing, or test-local counter. This preserves D072's ownership semantics while
making the service proof exercise the real distributed SDK artifacts.

### D093: Focused CI owns immutable cross-runtime SDK service evidence

The generic `ci-integration` workflow continues to own the ordinary backend and service integration
surface, but explicitly excludes the two tests whose claim depends on packaged SDK identity:
authoritative chaos and authoritative LangGraph. It does not build an extra local TypeScript bundle,
wheel, or SDK-specific child-process environment for those tests. Running a second mutable build in
that workflow would duplicate time while proving different bytes and could let source-tree or
ambient-package behavior masquerade as release-artifact evidence.

The focused authoritative-control workflow is the sole owner of those two cross-runtime gates. It
builds and hashes the TypeScript tarball once, transfers that exact artifact to the service job,
installs it outside the workspace with exact peers, and installs the Python wheel plus exact
LangGraph/provider test dependencies in its clean environment. `pip check` is mandatory after the
Python environment is assembled. Chaos and LangGraph must fail closed unless their immutable
artifact identity variables are present, and their runners attest package paths, versions, and
hashes. Static CI-topology and immutable-artifact contracts ensure the generic workflow excludes
only those two delegated tests while the focused workflow remains their required owner.

The current TypeScript path reuses one hashed tarball, but the Python chaos and LangGraph jobs build
their wheels independently. They are useful clean-install tests, not one immutable artifact identity,
and do not yet meet D093; D105 records the required artifact DAG.

### D094: A dispatched attempt remains controlled until its consumer lifecycle closes

Provider dispatch begins an ambiguous paid interval. A caller signal, native provider controller,
facade close, reader cancellation, iterator return, stream error, or terminal provider observation
may end consumer work, but none may silently leave the reservation heartbeat alive. During active
consumption the TypeScript wrappers observe only the exact validated caller signal and the exact
native controller tied to that stream. A live stream that has not yet been pulled is registered with
its facade lifecycle so closing the facade also stops and detaches it. Once any terminal path wins, a
single guard prevents heartbeat restart, duplicate provider abort, or later commit/release. Because
dispatch already occurred, cancellation, close, or an observer exception retains unresolved capacity
for expiry/reconciliation rather than fabricating a release or an exact charge.

The controlled facade is the public stream boundary. It preserves the supported official prototype
and controlled iteration, `toReadableStream`, and controller behavior needed by consumers, but does
not expose a raw peer iterator, reflective escape to the native stream, or an uncontrolled `tee`
branch. The final local ESM and CJS installed-package tests prove the same boundary; the remote CI
record remains pending. This is the concrete implementation of D085 and D086's post-dispatch
consumer-lifecycle promise; merely stopping work at the visible iterator without stopping the
registered heartbeat is a control defect, even if the provider request itself was already correctly
retained as unresolved.

Python applies the same lifecycle rule through weak client state and a weak lease for each
post-reservation attempt. The public sync/async stream and manager facades are narrow, slots-only
objects and do not forward ordinary attributes that expose raw provider responses, clients, stream
factories, transports, credentials, or mutable lifecycle state. Copy, pickle, and ordinary mutation
paths do not create an uncontrolled public facade. Facade close atomically marks the client closed,
cancels every live dispatched lease, stops its registered heartbeat, and abandons consumer
observation without commit or release. A non-stream response racing with close must cross the same
lease before settlement, so close wins without fabricating exact usage even when the official client
has already returned a value. D095 limits this statement to the supported public integration surface;
it is not a claim that Python private state resists hostile interpreter introspection.

### D095: Python SDK enforcement is not a hostile same-process sandbox

Python deliberately exposes runtime introspection powerful enough to recover implementation state. A
caller can inspect a bound method's `__func__.__globals__`, closures, or module objects, monkeypatch
code or dependencies, recover captured provider methods/factories from otherwise private state, or
skip the SDK and send provider HTTP directly. Slots, weak maps, name mangling, frozen facades, and
obfuscation can reduce accidental misuse and keep unsupported capabilities out of the ordinary public
API, but cannot form a security boundary against code with those same-process powers. Tests must not
claim reflection-proof Python state or treat the absence of a normal attribute as proof that a
malicious caller cannot bypass an in-process wrapper.

The SDK guarantee therefore assumes cooperative application code routes every paid path through a
supported controlled API. If the threat model includes adversarial plugins, tenants, agents, or
application code, the application process must not possess reusable provider credentials or
unrestricted provider egress. Credentials and outbound provider calls must live behind a trusted
proxy/control-plane boundary that performs authoritative reserve/dispatch/settle, with network and
secret isolation preventing direct calls around it. This limitation does not weaken refusal behavior
for supported integrations; it defines where that behavior can honestly be treated as enforcement
rather than an opt-in library convention. For Python, this explicitly qualifies D086's statement
that a facade does not expose its private client or transport: it does not expose them through the
supported public API, but the claim does not extend to hostile interpreter introspection.

### D096: Python async provider facades are owner-event-loop affine

An `AsyncOpenAI` or `AsyncAnthropic` controlled facade binds cooperatively to the first event loop
that performs an operational create, stream, or close. Every later operation on that facade and
every controlled stream or manager produced by it must run on that same live loop. A wrong-loop use
fails locally with `PylvaStrictProviderError(reason="invalid_client")` before a new reservation or
provider network request; a wrong-loop close cannot start a second private-client or raw-stream
shutdown. This is an explicit operational contract, not a cross-thread scheduler or a promise to
move an official provider client between event loops.

Applications must therefore keep one controlled async facade inside one long-lived operational
loop, await every stream/manager close and the facade's `close()` on that loop, and complete shutdown
before tearing the loop down. Repeated `asyncio.run()` calls must not share a facade. If the owner
loop is destroyed while private shutdown is still pending, a later loop cannot safely recover that
official-client lifecycle; local `invalid_client` is the honest outcome. This affinity is compatible
with D095's cooperative integration boundary and must be documented for async LangGraph workers and
other framework hosts that manage their own loops.

### D097: Async provider-stream failure schedules raw shutdown before cancellation

An async provider-stream failure establishes its durable local terminal actions before the first
cancellation point. It marks the controlled stream terminal, stops and unregisters its heartbeat,
detaches its finalizer, abandons the lifecycle lease so settlement cannot restart, and schedules one
memoized raw official-stream shutdown task. Only after that task exists may the failure path await
heartbeat quiescence or provider cleanup. Caller cancellation therefore cannot land in a gap where
consumer observation ended but the raw provider stream remained open with no scheduled owner-loop
cleanup.

The shutdown task is exact-once and shared by implicit failure cleanup, explicit stream/manager
close, facade close, and concurrent callers. Awaiting it is shielded from cancellation; an explicit
later close can join the same task and observe its result rather than invoking the provider close a
second time. Dispatch has already occurred, so this cleanup stops further provider/consumer work and
heartbeat extension while retaining the reservation as unresolved; it never fabricates a release or
an exact commit. D096 still applies: the owner loop must remain alive until the scheduled shutdown
completes.

### D098: One hash-addressed Python wheel/sdist pair is the local release evidence unit

The final local `pylva-sdk` 1.2.0 artifact pair is immutable evidence addressed by SHA-256. The wheel
at
`/private/tmp/pylva-final-python-20260715-S9DgSw/dist/pylva_sdk-1.2.0-py3-none-any.whl`
has digest `f26aeacad94aa073c42c764968cb7b4d3361fb99f622e4cf20882fe36ff8d74d`; the sdist at
`/private/tmp/pylva-final-python-20260715-S9DgSw/dist/pylva_sdk-1.2.0.tar.gz` has digest
`8574d814089a243787e9ef751eaee8e39be7305f46db5eaf5daedb563eb20175`. Archive inspection and all
four wheel/sdist-by-provider-floor/current installed profiles consume those bytes, exercise official
sync and async providers, and leave both hashes unchanged. No downstream gate may rebuild either
format and attribute its result to these digests.

The exact wheel also owns the final local Python cross-runtime service evidence. Its clean Python
3.12 environment passes `pip check` with LangGraph 1.2.9, LangChain 1.3.13, OpenAI 2.45.0, and respx
0.23.1. Together with TypeScript tarball SHA-256
`776c4e7683adbb7f276e837507c38728e2365e1dac228f11f02addd674edabf3`, it passes the immutable
two-SDK chaos group 11/11 and LangGraph group 4/4 across three files. These digests and local passes
do not identify a published package, tag, merged commit, remote CI run, deployed environment, or
activated rollout; each remains separate external evidence.

### D099: Packaged documentation is part of immutable TypeScript artifact identity

The README shipped inside the npm tarball is part of the release-evidence unit and must be byte-for-
byte identical to the final package source README. Runtime, topology, and compatibility success
cannot make a tarball release-ready when its packaged documentation is stale. The D089 runtime
candidate is therefore superseded rather than silently relabeled.

The replacement final local `@pylva/sdk` 1.2.0 tarball at
`/private/tmp/pylva-final-ts-20260715-postdocs-Qr3Gd1/pylva-sdk-1.2.0.tgz` has SHA-256
`776c4e7683adbb7f276e837507c38728e2365e1dac228f11f02addd674edabf3`. Its packaged README exactly
matches `packages/sdk-ts/README.md`. The exact same bytes pass artifact topology and source maps,
optional-peer-free loading, floor and current strict peers, AI SDK 3/4/5 refusal, official ESM/CJS
streams and lifecycle, identity, and every fixed size gate. Paired with the D098 Python wheel, those
same bytes also pass the final real-service chaos group 11/11 and LangGraph group 4/4 across three
files. No downstream gate rebuilt or repacked this replacement candidate.

This replacement is local immutable evidence only. It is not a published package, tag, merged
commit, remote CI run, deployment, or activated rollout.

## 2026-07-17 — Independent-QA qualifications and durable lessons

### D100: Public control routes sanitize missing trusted context

The five machine-only budget-control routes depend on middleware-injected builder and key identity,
but the names and shape of those trusted headers are private implementation details. A direct route
invocation with missing context returns the same generic, non-cacheable internal error from
capabilities, reserve, commit, release, and extend; it never echoes header names or middleware
instructions. Route regressions inspect the complete response body, not only status and cache
headers. The capabilities route does not yet meet this decision and remains a release blocker.

### D101: Mixed dashboard pages split legacy and authority reads by credential

D084 applies even when one page needs both ordinary catalog rows and authoritative status. Legacy
catalog queries run through `withRLS`; authority queries run through
`withBudgetControlReadTransaction`; the page combines the two bounded tenant results in memory. A
join through the general pool is not acceptable, and widening the general role's authority ACL is
not a fix. Production-shaped browser coverage visits every dashboard page that displays authority,
including Cost Sources. Owner-backed unit mocks are not credential-topology evidence.

### D102: A posture freshness bound is end to end, not per cache layer

The five-second ClickHouse role-drift promise is measured from the last completed accepted
attestation to the last use it authorizes. Two independently expiring five-second caches can reuse an
almost-expired attestation and then cache its client again, exposing drift for almost ten seconds.
All layers must share one attestation expiry or only one layer may cache success. The regression
primes inner and outer caches at different clock offsets and measures the composed default path.

### D103: Date-only ClickHouse filters still require explicit UTC instants

Binding `YYYY-MM-DD` and casting it with `::Date` is not an explicit UTC boundary when compared with
`DateTime` or `DateTime64`; ClickHouse can promote the date through the server timezone. Timestamp
windows bind explicit UTC start/end strings and parse them with
`parseDateTime64BestEffort(..., 3, 'UTC')`. Repository scans and non-UTC service tests cover implicit
date-to-timestamp casts as well as native placeholders and timezone-less parsers.

### D104: Exception messages are untrusted public and log data

An exception message can contain a credential-bearing URL, provider payload, SQL detail, or internal
header contract. Public failures return a generic sanitized body. Runtime logs record an allowlisted
error class/code or SQLSTATE and an opaque correlation reference, not `error.message` or
`String(error)`. A response-only assertion is insufficient: privacy regressions capture and inspect
the logger call as well.

### D105: Immutable service evidence is a CI artifact-DAG property

Building the same source and version twice does not produce one proven artifact identity. Focused CI
builds and hashes one Python wheel/sdist pair, uploads it, and makes package, chaos, LangGraph, and
release consumers download those exact bytes. Each consumer verifies the expected SHA-256 before
and after use, reports the installed path and version, and rejects source-tree or ambient-package
substitution. Independent per-job wheel builds may be clean-install smoke evidence but cannot satisfy
D093 or D098. The current Python service jobs do not yet meet this decision.

### D106: Network-intercepted service tests use an explicit allowlist

A deterministic provider fixture may forward only the exact configured local Pylva backend origin
and intercept the exact supported provider route. Every other scheme, origin, and path fails before
network I/O. Falling through to the process's real `fetch` for an arbitrary origin invalidates a
no-network-escape claim even when no unexpected request happened in the observed run.

### D107: Publishing attests the complete exact-SHA release graph

A green focused workflow does not replace repository fast CI, security, ordinary integration, or
ordinary dashboard E2E. Tag-triggered publishing independently attests every required workflow for
the exact release SHA. A prerelease version uses explicit SemVer/PEP 440 metadata and an explicit
non-`latest` npm dist-tag. Published bytes are the service-tested bytes, or the complete artifact and
cross-runtime service gates rerun against the newly built publication hashes.

### D108: Public validation errors do not depend on Python hashability

Configuration accepts untrusted runtime objects, so enum-like validation first proves that a value
is a string and only then performs membership testing. Lists, dictionaries, and other unhashable
values raise `InvalidControlConfigError`, never native `TypeError`. The same principle applies across
both SDKs: arbitrary malformed input terminates through the documented error family.

### D109: Privacy enforcement is structural, not secret-content classification

Closed schemas prevent content-bearing fields from entering control payloads, but they do not detect
whether an allowed provider, model, metric, customer, or step string contains secret-like text.
Public claims describe field-level allowlisting honestly. Applications keep sensitive content out of
allowed identifiers, and diagnostics omit or fingerprint user-controlled identifiers when their
content is not operationally required.

### D110: Packaged documentation is artifact identity in both SDKs

D099 applies across both ecosystems. The npm tarball README is byte-identical to
`packages/sdk-ts/README.md`. The Python sdist README is byte-identical to
`packages/sdk-py/README.md`, and wheel core metadata carries the expected content type and normalized
long description. Any README change supersedes artifacts built before it, even when runtime files
and versions are unchanged. Archive-member presence alone is not equality evidence.

### D111: Migration phases are ordered cuts and rollback evidence closes under concurrent writes

Rollout phases are boundaries in the ordered pending filename sequence, not independent buckets.
`pre_roll` stops before the first pending `post_roll` marker; after that prefix is complete,
`post_roll` owns the marker and the entire remaining suffix. Checked-in phase metadata is part of the
migration artifact; assembling only `db/migrations/` can silently destroy migration 048's app-first
compatibility boundary.

Bounded online preparation commits between batches, so a final empty scan is not proof that an old
writer cannot insert one more legacy row. Every supported entrypoint takes the final
write-conflicting lock and copies late rows into the rollback table before conversion. Migration
048's backup proves historical scope only for keys that existed with a legacy scope before the cut;
a rollback fences key issuance and explicitly resolves later universal-only keys rather than
guessing a historical value. Manifest identity, migration-ledger identity, and physical-schema
verification prove different facts and all three are required.

### D112: Reuse shared semantic types before declaring local unions

Before declaring a TypeScript string-literal union, search `packages/shared/src/types/` for the same
semantic values. Import the existing shared type when the values match; use
`Extract<SharedType, ...>` for an intentional subset. Keep a local union only when it represents a
genuinely different concept, and document that distinction. Apply this rule to runtime code, SDKs,
API contracts, dashboard models, and tests.

```ts
// Avoid
type Period = 'hour' | 'day' | 'week' | 'month';

// Prefer
import type { BudgetRulePeriod } from '@pylva/shared';
```

This prevents backend, SDK, and dashboard contracts from drifting independently. The rule was
promoted from recurring review feedback after seven separate type-reuse misses.

### D113: Free disk is a validation precondition for artifact-heavy work

Before starting package matrices, browser installs, local databases, or parallel clean-artifact
service jobs, record available disk space. Below 2 GiB free, do not start parallel artifact or
service tasks: finish and clean one owned task at a time until capacity recovers. Cleanup removes
only task-owned temporary artifacts, environments, databases, and worktrees; it never uses
destructive repository reset as a space-recovery shortcut. Evidence records the capacity check and
the location/digest of artifacts that must be retained.

### D114: The public documentation inventory is an enforced source boundary

`tests/repo-boundary/docs-source.test.ts` defines the documentation filenames intentionally allowed
in the public repository. A documentation update first fits durable material into those approved
plan, decision, rollout, operations, readiness, LangGraph, and release-note surfaces. Adding a new
top-level docs source file requires an explicit public-source policy decision and matching boundary
review; documentation work does not silently widen the allowlist merely to make its own test pass.
