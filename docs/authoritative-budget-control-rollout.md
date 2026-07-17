# Authoritative Budget Control: Upgrade and Rollout Guide

> Status: rollout groundwork, not an activation record. The repository default remains
> `ENABLE_AUTHORITATIVE_BUDGET_CONTROL=false`. Following this guide does not mean a builder or
> environment has passed the release gates.

This guide explains how to introduce server-owned LLM and non-LLM budget control without treating
missing legacy spend as zero, losing an in-flight reservation, or confusing analytics with the
authorization ledger. Use it with the
[PostgreSQL migration safety procedure](./authoritative-budget-control-operations.md#postgresql-migration-phase-and-rollback-safety),
[reservation-expiry operations runbook](./authoritative-budget-control-operations.md), and the
[release-readiness checklist](./authoritative-budget-control-release-readiness.md).

## Safety model

The application must reserve a conservative maximum immediately before dispatching a paid
operation. It commits exact usage after the provider returns. It releases a reservation only when
there is proof that dispatch did not happen. If dispatch may have happened but the result is
unknown, the reservation expires to `unresolved`; it is never silently refunded.

PostgreSQL is the authorization authority. ClickHouse is a retryable analytical projection and
must never decide whether a call can spend money. The backend feature flag stops new reservations,
but it does not stop commit, release, expiry, late-commit, or projection work for reservations that
already exist.

## Machine HTTP contract

The SDK 1.2 source-candidate wire source of truth is
`packages/shared/src/types/budget-control.ts`, with cross-runtime examples in
`tests/contracts/budget-control-contract.json`. The authoritative-control namespace is machine-only:

| Method | Path                                       | Purpose                                                              |
| ------ | ------------------------------------------ | -------------------------------------------------------------------- |
| `GET`  | `/api/v1/budget/capabilities`              | Report schema, lease bounds, server time, and live control readiness |
| `POST` | `/api/v1/budget/reservations`              | Price and atomically reserve, deny, bypass, or report unavailability |
| `POST` | `/api/v1/budget/reservations/{id}/commit`  | Replace protected capacity with exact server-priced usage            |
| `POST` | `/api/v1/budget/reservations/{id}/release` | Release only with proof that the provider was not charged            |
| `POST` | `/api/v1/budget/reservations/{id}/extend`  | Extend a still-live lease using an idempotent `extension_id`         |

The exact roots and every descendant remain API-key authenticated even when a URL is malformed,
unknown, or uses the wrong method. They never fall through to dashboard JWT authentication.
Middleware removes caller-supplied trusted identity headers and injects builder/key identity only
from the verified universal API key.

`X-Pylva-SDK-Version` and `X-Pylva-SDK-Language` are bounded observability metadata, not
authentication or tenant authority. Invalid values become `unknown`.

Control traffic uses a dedicated per-key bucket of 600 requests per 60 seconds. Redis throttling is
fail-open admission control, not financial authority; PostgreSQL serialization remains authoritative
during a Redis outage.

### Request boundary

Mutation bodies have a hard 16 KiB raw-byte limit. `Content-Length` is advisory: oversized chunked
bodies and dishonest declared sizes are still stopped while streaming. Decoding is fatal UTF-8,
followed by strict JSON and strict request-schema validation.

Unknown request properties are rejected. Invalid bytes, body overflow, malformed JSON, invalid UUIDs,
and schema failures return a non-cacheable `400` without invoking the service. Routes never log or
reflect raw request bytes.

Responses are validated but forward-compatible: SDKs may ignore additive response properties while
still rejecting unknown discriminators, contradictory literals, malformed identities, or invalid
arithmetic.

### Public status taxonomy

|        Status | Meaning                                                                                                      |
| ------------: | ------------------------------------------------------------------------------------------------------------ |
|         `200` | Capability result, control decision, or successful/idempotent lifecycle result                               |
|         `400` | Invalid UTF-8, body size, JSON, path UUID, or closed request schema                                          |
|         `401` | Missing or invalid universal API key                                                                         |
|         `404` | Reservation absent for the authenticated builder; cross-tenant existence is not disclosed                    |
|         `409` | Idempotency identity reused with a different canonical request, or lifecycle conflict                        |
|         `429` | Dedicated control-bucket throttle; includes `Retry-After`                                                    |
|         `500` | Sanitized unexpected route, response-validation, or internal-contract failure                                |
|         `503` | Sanitized authoritative store, schema, or frozen-pricing readiness failure                                   |
| `404` / `405` | Framework response for an unknown child or unsupported method, still API-key authenticated and non-cacheable |

Every middleware and route outcome carries `Cache-Control: no-store`. Migration-048 universal keys
have no live scope-based `403` path; `WRONG_SCOPE` remains a compatibility schema value, not a
current authorization outcome.

> Current blocker (2026-07-17): the capabilities route does not yet sanitize the missing
> trusted-context response the same way as the four mutation routes. Until fixed and
> regression-tested, the contract above is a release requirement rather than a complete
> implementation claim.

### Lifecycle, privacy, and authority

One `operation_id` represents one potentially billable provider attempt. Identical transport retries
replay the stored reserve decision; reuse with a different canonical request returns `409`. A
separately chargeable retry, route, or fallback requires a new operation ID.

Commit, release, and extend are idempotent. A distinct extension uses a distinct `extension_id`.
Conflicting terminal transitions cannot refund or charge twice. Extension cannot revive an expired
lease. Ambiguous expiry moves capacity from `reserved` to `unresolved`; a late exact commit or
proven-uncharged release may later settle it.

Disabling new control makes capabilities report disabled and reserve return `control_disabled`
without depending on PostgreSQL. It does not disable commit, release, expiry, projection, or other
maintenance for existing reservations.

Privacy is structural, not semantic secret detection. The contract has no prompt, message,
completion, raw-error, tool-argument, credential, URL, private-payload, or client-dollar field.
Supported wrappers never map those values into control requests or diagnostic logs. Allowed
identifiers are shape- and storage-safe, but applications must still keep sensitive content out of
them. Failure-path tests inspect structured logs as well as HTTP responses.

PostgreSQL owns authorization, reservations, lifecycle state, and exact billing facts. ClickHouse is
a retryable analytical projection. Redis and SDK-local memory are never control authorities.

## SDK upgrade and configuration

SDK 1.x keeps the compatible defaults `legacy` and `allow`. Installing a 1.2 SDK does not silently
turn enforcement on.

The TypeScript and Python source metadata currently identify `@pylva/sdk` and `pylva-sdk` as 1.2.0
candidates. Do not tell users to install 1.2.0 until the packed artifacts, release gates, and
registry publication are complete.

After the corresponding artifacts are actually published, applications can install their pinned
versions in the normal package-manager lockfile. Configuration is explicit:

```ts
import { init, ready } from '@pylva/sdk';

init({
  apiKey: process.env.PYLVA_API_KEY!,
  control: {
    mode: 'shadow', // legacy | shadow | enforce
    onUnavailable: 'allow', // allow | deny
    timeoutMs: 2_000,
  },
});

const capability = await ready();
```

```python
import os
import pylva

pylva.init(
    os.environ["PYLVA_API_KEY"],
    control={
        "mode": "shadow",  # legacy | shadow | enforce
        "on_unavailable": "allow",  # allow | deny
        "timeout_ms": 2_000,
    },
)

capable = await pylva.ready()
# Synchronous applications use pylva.ready_sync().
```

The modes have deliberately different meanings:

| Mode      | Reservation behavior                                                     | Appropriate use                                          |
| --------- | ------------------------------------------------------------------------ | -------------------------------------------------------- |
| `legacy`  | No authoritative request; returns a local `control_disabled` bypass      | Existing 1.x behavior and emergency application rollback |
| `shadow`  | Evaluates and records a would-allow/would-deny result but does not block | Comparison and canary stages                             |
| `enforce` | A hard denial stops dispatch; a successful reservation must be settled   | Opt-in controlled traffic only                           |

`onUnavailable=allow` does not fabricate an allowed authoritative decision. It returns an honest
`unavailable` result so the application can follow its declared fallback policy. `deny` raises the
control-unavailable error and is required for the strict demonstration.

For non-LLM tools, the application must provide a cost-source identity, metric, and conservative
maximum before dispatch. If pricing or a safe maximum is unknown, strict control returns
`usage_bound_required` or `pricing_unavailable`. Calling the tool first and reporting later records
cost, but it cannot prevent that cost.

## SDK architecture and controlled-attempt lifecycle

The TypeScript and Python candidates implement the same responsibilities in language-appropriate
layers:

| Responsibility                              | TypeScript                                                                                   | Python                                                              |
| ------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Configuration and identity generation       | `core/config.ts`, `core/identity.ts`, `core/identity_registry.ts`                            | `core/config.py`                                                    |
| Validated readiness and lifecycle transport | `core/control_client.ts`, `core/control_wire.ts`                                             | `core/control_client.py`, `core/control_schema.py`                  |
| One reserve/dispatch/settle attempt         | `core/control_attempt.ts`                                                                    | `wrappers/_controlled_provider.py`                                  |
| Exact and bounded non-LLM control           | `core/controlled_usage.ts`                                                                   | `core/controlled_usage.py`                                          |
| Strict LLM integrations                     | `wrappers/openai_controlled.ts`, `wrappers/anthropic_controlled.ts`, `wrappers/vercel-ai.ts` | `wrappers/openai_controlled.py`, `wrappers/anthropic_controlled.py` |
| Tavily basic-search adapter                 | `adapters/tavily.ts`                                                                         | `adapters/tavily.py`                                                |
| Wrapper/callback ownership                  | `core/control_correlation.ts`, `langgraph.ts`                                                | `core/control_ownership.py`, `langchain/callback.py`                |
| Legacy telemetry fallback                   | `core/telemetry.ts`                                                                          | `core/telemetry.py`                                                 |

TypeScript paths are relative to `packages/sdk-ts/src/`; Python paths are relative to
`packages/sdk-py/pylva/`.

One controlled attempt has this invariant sequence:

1. Validate the supported price-complete request and detach one bounded snapshot before any await or
   reservation.
2. Capture the SDK identity generation, provider/tool target, invocation closure, and fresh operation
   identity.
3. Reserve immediately before dispatch. A denial or fail-closed control error invokes the paid
   closure zero times.
4. Dispatch only through the supported controlled integration.
5. Commit exact supported usage when terminal evidence is trustworthy.
6. Release only when local evidence proves dispatch never occurred.
7. After dispatch, missing usage, cancellation, transport ambiguity, close races, or settlement
   failure leave the reservation unresolved for expiry and reconciliation.

The backend, not the SDK, prices authoritative dollars. SDK requests contain bounded usage units and
content-free correlation fields.

### Identity, telemetry, and graph ownership

A validated `reserved` decision gives the authoritative lifecycle ownership of that operation's
billable record. The matching legacy event is suppressed using exact operation ID, reservation ID,
and current SDK identity—not model name, timing, or callback proximity. Ownership survives a lost
commit acknowledgement because emitting a legacy event would double-count an attempt that will
either settle or expire unresolved.

`bypassed` and allowed `unavailable` attempts do not fabricate authorization. Their supported
wrappers retain one legacy telemetry record. Changing endpoint or API key advances the identity
generation, aborts old work, clears tenant-scoped caches/correlation, and prevents late callbacks
from moving state into the new tenant.

LangGraph callbacks are observers, not an authorization boundary. In `auto` mode, one explicit
control scope can correlate one callback start with one controlled provider or tool invocation. Zero
or multiple candidates are ambiguous and remain unsuppressed. `callback` intentionally records
callback telemetry, and `off` ignores LLM callbacks. One scope must not cover a multi-step graph. See
the [LangGraph ownership guide](./langgraph-authoritative-control.md) for exact ordering rules.

### Provider, stream, non-LLM, and artifact boundaries

Strict wrappers use only the supported private official-provider dispatch surface and disable
provider retries. A fallback is a new paid attempt with a new reservation. Streaming remains
controlled until EOF, cancellation, iterator return, error, or facade close stops its heartbeat and
consumer lifecycle. Post-dispatch termination never fabricates a release.

Python async facades, streams, and managers belong to their first operational event loop. Shutdown
must finish on that loop before it is destroyed.

Generic exact/bounded helpers control any operation for which the caller supplies a known cost
source, metric, and conservative maximum before dispatch. The Tavily helpers have no runtime
dependency on a Tavily package; their supported boundary is a client exposing the documented sync or
async `search` shape. The current candidate does not claim a tested official Tavily package-version
range. Add installed official-package floor/current gates before making that compatibility claim.

Source tests prove source behavior. Release evidence exercises one hash-addressed npm tarball and one
hash-addressed Python wheel/sdist pair. Every package, compatibility, chaos, and LangGraph consumer
verifies those same bytes before and after use; rebuilding in a downstream job creates a different
candidate.

## Application and provider trust boundary

Strict SDK control assumes cooperative application code routes every paid operation through a
supported controlled wrapper or helper. It is not a hostile same-process sandbox. Code that holds a
provider credential plus unrestricted provider egress can bypass any in-process SDK; Python code can
also deliberately introspect or monkeypatch library internals. Before rollout, document which code
is trusted to run with provider credentials. If plugins, tenants, agents, or other code are
adversarial, move credentials and provider egress behind a trusted proxy or control plane that owns
reserve/dispatch/settle, and enforce that separation with secret and network policy.

Python controlled `AsyncOpenAI` and `AsyncAnthropic` facades and their streams are cooperatively
affine to the first operational event loop. Reuse them only on that loop; a wrong-loop operation or
close fails locally as `invalid_client` before a new reservation or provider network request. Do not
share one facade across repeated `asyncio.run()` calls. Graceful rollout and rollback procedures
must await every controlled stream/manager and facade close before the owner loop is torn down. On
an async stream failure the SDK schedules exact-once raw provider shutdown before its first
cancellation point, but the loop still must remain alive long enough to finish that task.

## Data-store credential and role boundary

Production uses three independent PostgreSQL login principals plus one fixed NOLOGIN owner group.
The login purposes are not aliases for one another:

| Purpose                        | Environment input                                                  | Required posture                                                                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| General Next.js application    | `DATABASE_URL`; `GENERAL_APP_DATABASE_URL` only while provisioning | Ordinary `LOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`; exactly one no-ADMIN/no-SET outbound membership in `pylva_general_app_runtime` |
| Fixed legacy application owner | No credential: `pylva_general_app_runtime`                         | `NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS`; owns only migration 054's exact temporary compatibility allowlist and has no authoritative/control ownership or ACL       |
| Authoritative budget control   | `BUDGET_CONTROL_DATABASE_URL`                                      | Dedicated `LOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION` principal that is a member of `pylva_budget_control_runtime`                   |
| Schema migration               | `MIGRATION_DATABASE_URL` or `MIGRATION_DB_*`                       | Separate object-owner/`CREATEROLE` migration principal; no `SUPERUSER` or `BYPASSRLS`; non-inheriting administrative/SET edges exist only for forward migration work   |

`GENERAL_APP_DATABASE_URL` must identify the same login and database that the deployed application
will use as `DATABASE_URL`; it is a restricted provisioning-task input, not a fourth runtime
credential. Never reuse a principal or secret ARN across the general, budget-control, and migration
purposes. Password rotation does not make the same username a different principal. When
`BUDGET_CONTROL_DB_RUNTIME_USER_SECRET_ARN` is configured, its JSON `username` must exactly match
the username in `BUDGET_CONTROL_DATABASE_URL`; a mismatch or refresh failure closes the control
path.

Production has no fallback from the budget or migration connection to `DATABASE_URL`. The package
scripts permit throwaway local/CI reuse only through
`ALLOW_BUDGET_CONTROL_DATABASE_URL_FALLBACK=true` and
`ALLOW_MIGRATION_DATABASE_URL_FALLBACK=true`; both fallbacks are rejected when
`NODE_ENV=production`. The Next.js container rejects every `MIGRATION_*` database variable, and the
migration container rejects general and budget-control database variables. Keep
`GENERAL_APP_DATABASE_URL` in the separate provisioning task and out of the application container.

ClickHouse has a separate two-principal boundary. `CLICKHOUSE_URL` remains the dashboard/billing
reader and legacy `cost_events` ingest identity; it must not be able to insert into the authoritative
`budget_cost_events` table. `BUDGET_PROJECTION_CLICKHOUSE_URL` is reserved for the immutable
PostgreSQL-outbox projector. It may insert and inspect `budget_cost_events`, but it must not alter or
drop schema, manage users or grants, write unrelated tables, or receive global privileges. A missing,
reused, or over-privileged projector identity fails production projection readiness. Local and CI may
reuse the throwaway general URL only with
`ALLOW_BUDGET_PROJECTION_CLICKHOUSE_URL_FALLBACK=true`; production never falls back.
Both production application URLs must contain non-default usernames and passwords and use HTTPS.
Provision them with the idempotent `pnpm clickhouse:provision-budget-rbac` command documented in the
operations runbook. Its admin-level catalog audit revokes authoritative `INSERT` from every user and
role except the fixed projector role and the explicit break-glass provisioning admin. Runtime then
attests each application's exact sole active/default role and exact fixed-role grants. Failed
attestations are immediately retryable after repair. A successful posture may authorize use for no
more than five seconds **end to end across every cache layer**. Until the nested client and posture
caches are collapsed to that bound and covered by a regression test, this prerequisite is not
satisfied; two individually five-second caches do not prove a five-second effective bound.

Migration 052 creates the fixed `NOLOGIN NOINHERIT` group
`pylva_budget_control_runtime`, two isolated `NOLOGIN NOBYPASSRLS` discovery owners, their bounded
functions, exact column grants, and role-specific actionable-row RLS policies. Migration 053 then
restores the documented table-owner bypass for the four legacy catalogs needed before tenant context
exists, while leaving RLS enabled and all nine authoritative/control tables FORCEd.

Migration 054 adds the separate fixed `pylva_general_app_runtime` owner group and transfers exactly
the named pre-authoritative application relations, current `audit_log` partitions, three legacy
sequences, one view, `generate_slug(text)`, and the bounded audit-partition routine. It grants the
group read-only migration-head visibility but no authority relation/sequence ownership or ACL. The
full closed list is recorded in decision D078 and asserted by the migration; a new legacy object does
not enter the boundary through a wildcard. A future audit child enters only when the bounded routine
creates it as a correctly bounded partition of the exact `audit_log` parent and as the fixed group.
This is a temporary compatibility bridge: the inherited owner path and schema `CREATE` remain
broader than the future fully non-owner target.

Provision the general login from a restricted task after migration 054, using the same target URL
that will become runtime `DATABASE_URL`:

```bash
MIGRATION_DATABASE_URL='postgresql://<migrator>:<password>@<host>:5432/<database>' \
GENERAL_APP_DATABASE_URL='postgresql://<general-app>:<password>@<host>:5432/<database>' \
pnpm exec tsx scripts/ci/provision-general-app-runtime.ts
```

The provisioner normalizes the ordinary login and exact membership, removes direct ACL drift, and
attests both effective legacy access and authority denial. It fails closed on dangerous role or
ownership drift that the ordinary migrator cannot safely repair. Do not expose either URL in logs,
source control, or the runtime environment beyond its intended credential boundary.

The public application and migration Docker targets do not package either PostgreSQL runtime
provisioner. A production deployment overlay must therefore supply a restricted one-off tool built
from the approved source SHA. Record the tool image digest, operator identity, execution time,
redacted target identity, exit status, and success marker. A workstation command or copied SQL is
not equivalent production provisioning evidence.

On PostgreSQL 16 and 17, creating that LOGIN as an ordinary `CREATEROLE` migrator adds one implicit
reverse creator edge: the application role is granted to the migrator with ADMIN, but without
INHERIT or SET. It is non-privilege-bearing and cannot be removed reliably by that migrator, so the
posture permits exactly this one portability edge. Any other member of the application role, or any
reverse edge with INHERIT or SET, is unsafe and provisioning fails. This does not give the
application login migration privileges.

After applying through 054 and provisioning the general login, create or repair the dedicated
budget login through the tested transactional provisioner:

```bash
NODE_ENV=production \
MIGRATION_DATABASE_URL='postgresql://<migrator>:<password>@<host>:5432/<database>' \
BUDGET_CONTROL_DATABASE_URL='postgresql://<budget-runtime>:<password>@<host>:5432/<database>' \
pnpm exec tsx scripts/ci/provision-authoritative-budget-runtime.ts
```

Require the terminal success marker `AUTHORITATIVE_BUDGET_RUNTIME_PROVISIONED`. The command
transactionally normalizes the login, password/settings, exact memberships and ACLs, database
`CONNECT`, fixed runtime-group posture, and runtime attestation. Do not replace it with a raw
`GRANT`: membership alone does not prove the complete security posture.

The login and every role reachable from it must own none of `builders`, `rules`, or the
authoritative tables; it must have no membership path to a superuser, a `BYPASSRLS` role, or either
discovery-function owner. Its session must keep `row_security=on` and be able to execute both
`pylva_budget_projection_actionable_builders(uuid, integer)` and
`pylva_budget_expiry_actionable_builders(uuid, integer)`.

The application performs one cached catalog attestation at every production boot, independently of
the reservation feature flag, and every default mutation/worker path refuses to return a database
client until posture is ready. Missing or unsafe credentials fail production startup, make
capabilities/control readiness false, and make mutation routes return a sanitized 503 before
reserve. A successful attestation is cached for the pool
lifetime: reconnects use the same URL-bound username, while the optional password provider verifies
that username on every secret refresh. Changing the login, membership, URL, or role grants requires
a process restart and fresh attestation.

Provisioning order is strict: apply through 054 with the migration connection using the same
historical migration time zone that created the existing audit partitions; provision and attest the
ordinary general login, then make that URL the runtime `DATABASE_URL`; provision and attest the
dedicated budget PostgreSQL login through the transactional command above; create the ClickHouse
users and run the exact RBAC provisioning command
against every deployment access-control scope; inject and verify `BUDGET_CONTROL_DATABASE_URL` and
`BUDGET_PROJECTION_CLICKHOUSE_URL`; and only then deploy the application image. Migration 054 compares
the existing audit partition bounds under the captured zone and fails closed on a mismatch rather
than creating a gap or overlap. Do this even while
`ENABLE_AUTHORITATIVE_BUDGET_CONTROL=false`: rule CRUD already uses the authoritative PostgreSQL
boundary, and projection must continue draining previously committed outbox rows. The flag prevents
new controlled reservations; it is not permission to deploy a missing data-store dependency.

## Backend runtime ownership map

Keep authorization, projection, dashboard reads, and presentation derivation in separate modules
and credential boundaries:

| Source boundary                   | Responsibility                                                                                   | Data-store boundary                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `src/lib/budget-control/`         | Accounts, pricing, reservations, lifecycle, rules, readiness, and expiry                         | Dedicated budget PostgreSQL URL with tenant context; this is the authorization authority                    |
| `src/lib/budget-projection/`      | Outbox claiming, reconciliation, projection, and billing closure                                 | Budget PostgreSQL plus projector ClickHouse identity; projection never authorizes                           |
| `src/lib/budget-activity/`        | Read-only Budget Activity and account-state queries                                              | Dedicated authority read adapter; do not route these reads through the general `withRLS` application client |
| `src/lib/cost-sources/`           | Pure cost-source labels, status derivation, and decimal presentation                             | No direct data access                                                                                       |
| General application posture layer | Authentication, legacy catalogs, dashboard analytics, and the migration-054 compatibility bridge | General PostgreSQL and reader ClickHouse identities only                                                    |

Machine control routes delegate to `budget-control`; projection workers delegate to
`budget-projection`. Budget Activity and account-state views already use the dedicated
`budget-activity` adapter. The Cost Sources page does not yet follow this map: it reads authority
tables through the general `withRLS` connection even though `src/lib/cost-sources/` contains only
pure presentation derivation. Refactor that page to split legacy and authority reads, then pass plain
view models into `cost-sources`; widening the general PostgreSQL principal is not a fix. Until that
production-shaped journey passes, Cost Sources remains an activation blocker.

## Backend prerequisites

Do not move any builder beyond legacy mode until all of the following are true:

1. PostgreSQL migrations `050_authoritative_budget_control_ledger.sql`,
   `051_authoritative_budget_control_runtime.sql`, and
   `052_authoritative_budget_control_runtime_roles.sql` are installed;
   `053_legacy_catalog_owner_rls_compatibility.sql` remains frozen; and
   `054_general_app_runtime_owner_boundary.sql` is the 50th migration and manifest head.
2. The migration, general-app, and dedicated budget-control principals satisfy the separation and
   role posture above. The general login passes real pre-tenant authentication/API-key bootstrap and
   tenant CRUD but cannot reach authority objects or `SET ROLE` its owner group. Direct cross-tenant
   `builders`, reservations, and outbox scans fail for the budget login; both bounded discovery
   functions work; `SET ROLE` to either discovery owner fails.
3. The audit runway created through `pylva_ensure_audit_log_partition(date)` continues the existing
   bound sequence in the captured historical migration time zone, while a mismatched upgrade bound
   fails closed. Audit create and retention/drop behavior are exercised through the general login.
4. `MIGRATION_DATABASE_URL=... pnpm db:migrate:verify-physical -- --contract
authoritative_budget_ledger` passes against the deployed database.
5. ClickHouse DDL is deployed through `012_cost_events_utc_timestamp.sql` and its doctor passes. The
   exact RBAC command passes; actual insert attempts by the general identity and an unrelated user
   or inherited global-writer role fail; the distinct projector can insert and inspect the table but
   cannot perform destructive, grant-management, or unrelated-table writes.
6. The expiry route is scheduled at least once per minute exactly as specified in the operations
   runbook, including while the reserve kill switch is off.
7. `POST /api/cron/project-budget-cost-events` is also invoked at least once per minute with
   `Authorization: Bearer <CRON_SECRET>`. Alert on every non-2xx response and on any reported
   reconciliation conflict, missing row, exhausted attempt, or high-attempt row.
8. `POST /api/cron/ensure-audit-partitions` is invoked daily and alerts on any non-2xx result.
9. The environment starts with `ENABLE_AUTHORITATIVE_BUDGET_CONTROL=false`.
10. The builder has one immutable readiness mode: `next_period` or `exact_backfill`.
11. Operators can observe outstanding `reserved` and `unresolved` capacity, projection lag,
    scheduler health, and authoritative versus legacy comparison results.

> **Activation blocker:** the public repository currently exposes readiness as an internal service,
> not as a public operator API or CLI. Before production activation, provide an audited,
> authenticated, retry-safe operator command that calls `createBudgetControlCutover`,
> `refreshBudgetControlCutover`, and `markBudgetControlReady`. It must record the acting operator,
> target builder and mode, immutable result identity, and current read-only status. Never update
> `budget_control_cutovers` directly: direct SQL bypasses the application audit surface and risks
> defeating the lock, adapter, and one-way lifecycle assumptions.

## Recommended path: next-period activation

Use `next_period` unless the business cannot wait for a safe boundary. It avoids reconstructing
current-period legacy spend.

1. Finalize the active budget rules that must be protected.
2. Through the operator command, call `createBudgetControlCutover(builderId, 'next_period')`.
   PostgreSQL chooses the latest next UTC boundary across every active hourly, daily, weekly, or
   monthly rule. The caller cannot choose an earlier timestamp.
3. Keep the builder pending. If active rules change, call `refreshBudgetControlCutover`. The
   boundary can move later but never earlier.
4. Keep legacy ingestion and billing reconciliation operating normally while pending.
5. At or after the returned boundary, call `markBudgetControlReady`. PostgreSQL rejects an early
   transition and makes a successful ready transition irreversible.
6. Pre-materialize known pooled and per-customer accounts if desired, then run the first-use load
   gate for the builder's expected cardinality. New per-customer accounts can still materialize on
   first use after readiness.
7. Leave the global feature flag off until shadow comparison and operational prerequisites are
   ready. Readiness alone does not enable control.

Rules created after readiness receive a lock-serialized authority order and can start with a proven
zero opening for their first eligible period. Existing rule origins are never reclassified using
wall-clock guesses.

## Exceptional path: exact backfill

Choose `exact_backfill` only when a current-period cutover is necessary and an operator-owned
durable traffic fence can make legacy spend stop changing at one watermark.

Every backend process must install the same adapter at process start:

```ts
import { installBudgetExactBackfillAdapter } from '@/lib/budget-control/exact-backfill-adapter';

installBudgetExactBackfillAdapter({
  async activate({ transaction, builderId, cutoverAt }) {
    // In this transaction, install or verify the durable legacy-writer fence and
    // the retry-safe reconciled manifest measured exactly through cutoverAt.
    // Do not call external services or perform non-transactional side effects.
  },

  async resolveOpening({ tx, builderId, ruleKey, subjectCustomerId, measuredThrough }) {
    // Read the fenced manifest through tx and return a canonical decimal string.
    // Throw when the pooled/customer/rule evidence is absent; never return a made-up zero.
    const opening = await readFencedOpeningFromSameTransaction({
      tx,
      builderId,
      ruleKey,
      subjectCustomerId,
      measuredThrough,
    });
    if (opening === null) throw new Error('reconciled opening evidence is absent');
    return opening;
  },
});
```

`readFencedOpeningFromSameTransaction` is deployment-owned pseudocode; it is not a helper supplied
by the public repository. A production adapter must meet all of these conditions:

- `activate` is retry-safe because the enclosing transaction may retry.
- The legacy-traffic fence and reconciliation watermark are durable writes in the supplied tenant
  transaction, not process memory or a remote side effect.
- The manifest includes every pooled account and every current or future per-customer identity the
  adapter promises to resolve.
- `resolveOpening` reads only the durable fenced state through the supplied transaction and checks
  `builderId`, rule identity, customer identity, and `measuredThrough`.
- Missing, stale, duplicate, or contradictory evidence throws. Absence is never interpreted as
  zero.
- The same adapter implementation is configured on every instance before capabilities traffic is
  accepted. A restart without it makes exact-backfill capabilities unavailable.
- Replacing the adapter object in a live process is forbidden.

Activation sequence:

1. Pre-stage and independently reconcile the legacy opening manifest.
2. Deploy the adapter everywhere while the feature flag remains off.
3. Call `createBudgetControlCutover(builderId, 'exact_backfill')` through the operator command.
   The database fixes the watermark at creation time.
4. Call `markBudgetControlReady`. Its exclusive builder transaction invokes `activate`, records the
   canonical reconciliation snapshot/hash, and makes the transition one-way.
5. Exercise known pooled and per-customer materialization, plus a deliberately absent customer.
   The absent case must fail closed and create no zero-opening account.
6. Reconcile the resulting opening-evidence rows against the source manifest before shadow traffic.

If the durable fence cannot be implemented, use `next_period`. A spreadsheet, dashboard total,
one-time query, or mutable feature flag is not an exact-backfill authority.

## Shadow comparison and canary checklist

Enable the backend flag only in the intended canary environment after readiness. Start clients in
`shadow` + `allow` so no provider/tool is blocked.

- [ ] One internal builder and a bounded customer cohort are selected.
- [ ] Every paid path in the cohort is inventoried and routed through a supported controlled wrapper
      or helper; any adversarial code is isolated from provider credentials and direct provider
      egress behind the trusted proxy/control-plane boundary.
- [ ] LLM input/output bounds and every non-LLM maximum are present before dispatch.
- [ ] Shadow results are split into calculated allow, calculated deny, and
      `shadow_control_unavailable`; unavailable is never counted as would-allow.
- [ ] Operation, trace, span, customer, step, rule, price revision, and cost-source identities match
      between the application record and authoritative decision.
- [ ] Legacy spend plus reconciled openings agrees with authoritative committed usage within the
      documented watermark; differences are investigated, not averaged away.
- [ ] Provider/tool calls equal application attempts in shadow, while simulated denials identify
      the exact calls that would have been skipped.
- [ ] Commit, release, late-commit, expiry-to-unresolved, and projection retries are exercised.
- [ ] ClickHouse projected totals reconcile to the PostgreSQL outbox without duplicate logical
      contributions.
- [ ] No prompt, completion, tool arguments, secrets, or provider payload bodies appear in control
      requests, logs, or dashboard data.
- [ ] The kill switch and client rollback order are rehearsed with an outstanding reservation.
- [ ] Python async workers prove same-loop facade/stream use and await controlled shutdown before
      tearing down their owner event loop.
- [ ] At least one full rule period completes without unexplained comparison drift.

Move one internal builder to `enforce` + `deny` only after this checklist is clean. Use deliberately
small test budgets first. Prove both an allowed/committed operation and a denied operation for an
LLM and for a priced non-LLM tool. A denial must invoke the provider/tool zero times.

## Rollback and kill switch

There are two different rollback goals, and their order matters.

To preserve application availability, first reconfigure controlled clients to `legacy` (or to the
approved shadow fallback), then set `ENABLE_AUTHORITATIVE_BUDGET_CONTROL=false`. An `enforce` +
`deny` client can deliberately refuse work when capabilities become disabled, so flipping only the
server flag is not an availability rollback for those clients.

To fail closed during suspected financial corruption, leave strict clients in `enforce` + `deny`
and set the server flag false. New paid operations will stop. Communicate that this is an intentional
traffic stop, not a transparent bypass.

In both cases:

- keep commit, release, late-commit, expiry, and projection routes deployed;
- keep all three cron schedules running;
- settle or expire every outstanding reservation;
- never delete ledger, allocation, transition, opening-evidence, outbox, or refusal rows;
- never reverse a ready cutover or edit its watermark;
- never downgrade migrations 050/051/052/053/054 as an incident response; and
- preserve comparison and reconciliation evidence for the post-incident review.

## Provider lifecycle warnings

- Reserve immediately before each independently priced routed or fallback attempt.
- Release only after a locally proven pre-dispatch failure, such as validation that prevented the
  request from leaving the process.
- A timeout, broken connection, cancelled stream, worker crash, or unknown provider response is not
  proof of no charge. Allow expiry to move the hold to `unresolved`, then late-commit when evidence
  arrives.
- Commit actual usage even when it exceeds the declared maximum. The ledger records the exact
  overage; it must not truncate or hide it.
- Extend long-running reservations before expiry. Extension cannot revive an expired hold.
- A retry or fallback that could incur a second charge needs a new operation/reservation identity.
  Reusing an operation ID with different bounds is an idempotency conflict.

## What this guide does not claim

The CI workflow and docs are readiness groundwork only. The repository now contains clean-artifact
cross-runtime contention, real authoritative LangGraph journeys, compatibility gates, and an
authenticated desktop/mobile Playwright journey showing projected commits and refusals. The final
local immutable TypeScript/Python candidates pass chaos 11/11 and LangGraph 4/4 across three files.
Those local passes do not prove that the required GitHub jobs passed on a frozen candidate, that
either package was published, that a production scheduler exists, or that shadow comparison and an
internal canary ran. Those remain explicit release evidence in the checklist.
