# Authoritative Budget-Control Operations

This runbook covers the server-owned reservation-expiry and authoritative-cost projection workers,
plus the general-application audit-partition runway affected by migration 054. All are operational
prerequisites: ambiguous provider attempts must move from `reserved` to `unresolved` after their
lease, immutable PostgreSQL cost events must reach the authoritative ClickHouse table before billing
can close, and audit writes must always have a valid monthly partition.

## PostgreSQL migration phase and rollback safety

Run migrations from the exact reviewed image or checkout. A custom migration image contains both
`db/migrations/` and its sibling `db/migration-phases.json`. If the phase file is absent, the runner
classifies every migration as `pre_roll`, removing migration 048's application-first boundary.
Production supplies only `MIGRATION_DATABASE_URL`; it does not inject runtime database credentials.

A migration phase is an ordered cut through the pending filename sequence, not an independent label
filter:

- `pre_roll` applies the pending prefix before the first pending `post_roll` marker.
- `post_roll` refuses to run while that prefix remains pending, then applies the marker and the
  entire remaining numbered suffix, including later files whose default metadata is `pre_roll`.
- An unqualified `pnpm db:migrate` applies every pending migration.

Migration 048 is currently the only `post_roll` marker. A live database pending migrations before
048 stops at 047 during `pre_roll`; after the compatible application is deployed, `post_roll`
applies 048 and the remaining suffix. If 048 is already recorded, later pending migrations such as
050–054 are eligible for `pre_roll`.

```bash
MIGRATION_DATABASE_URL='postgresql://<migrator>:<password>@<host>/<database>' \
  pnpm db:migrate --phase pre_roll

MIGRATION_DATABASE_URL='postgresql://<migrator>:<password>@<host>/<database>' \
  pnpm db:migrate --status --phase pre_roll --json

# Deploy and verify the application version that accepts legacy and universal scopes.

MIGRATION_DATABASE_URL='postgresql://<migrator>:<password>@<host>/<database>' \
  pnpm db:migrate --phase post_roll

MIGRATION_DATABASE_URL='postgresql://<migrator>:<password>@<host>/<database>' \
  pnpm db:migrate --status --json
```

A phase-specific status may report `state: "in_sync"` while listing later files under
`deferred_pending`; only that rollout stage is complete. Require final unphased status to report
`in_sync` with no pending, drift, or unknown files. `/api/v1/health` may remain HTTP 200 while its
schema payload says `behind` or `drift`, so aggregate health is not migration approval.

### Migration 048 final-write race

Migration 048 prepares data in bounded committed batches. A previous release can insert one last
legacy-scope key after the final empty batch. The supported `db:migrate` path therefore takes a
write-conflicting lock inside the final migration transaction, copies late rows into
`_048_api_keys_scope_backup`, and only then converts them to `universal`.

The one-second catalog/final-lock timeout is intentionally fail-fast so a queued migration cannot
stall authentication traffic; retry after contention clears. For a live 048 rollout, use
`db:migrate`. Do not substitute `db:apply:migration` until that manual path invokes the same final
transactional sweep.

### Migration 048 rollback boundary

Preserve `_048_api_keys_scope_backup` while any pre-048 release remains rollback-eligible. The table
contains only keys that previously had a legacy scope. Keys created after 048 as `universal` have no
historical value to restore.

Before rollback, fence API-key creation and inventory active universal keys absent from the backup:

```sql
SELECT k.key_id
FROM api_keys AS k
WHERE k.scope = 'universal'
  AND k.revoked_at IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM _048_api_keys_scope_backup AS b
    WHERE b.key_id = k.key_id
  );
```

For each result, issue a replacement through a reviewed operator procedure with the required legacy
scope and revoke the universal key; never infer a historical scope. Run rollback only through the
restricted `MIGRATION_DATABASE_URL` task. Restore backed-up scopes while writes remain fenced and
abort unless the active-universal-only inventory is empty before commit:

```sql
BEGIN;
LOCK TABLE api_keys IN SHARE ROW EXCLUSIVE MODE;
UPDATE api_keys AS k
SET scope = b.scope
FROM _048_api_keys_scope_backup AS b
WHERE k.key_id = b.key_id;
-- Re-run the active-universal-only inventory here and ROLLBACK if any row remains.
COMMIT;
```

Only then deploy the previous release.

### Three migration-verification layers

1. `pnpm db:manifest` binds migration filenames, SQL hashes, and phases into the application image.
   Include its generated change when an unapplied migration or phase changes; never edit an applied
   migration, because even a comment changes its checksum.
2. `pnpm db:migrate --status --json` compares `schema_migrations` with the exact SQL files and rejects
   checksum drift or unknown ledger entries.
3. Physical verifiers inspect the live catalog and data contract:

   ```bash
   MIGRATION_DATABASE_URL='postgresql://<migrator>:<password>@<host>/<database>' \
     pnpm db:migrate:verify-physical -- --contract api_keys_scope

   MIGRATION_DATABASE_URL='postgresql://<migrator>:<password>@<host>/<database>' \
     pnpm db:migrate:verify-physical -- --contract authoritative_budget_ledger
   ```

Run physical verification after migrations and runtime-role provisioning, with no concurrent DDL or
provisioner. The manifest, migration ledger, and physical contract prove different facts; none
substitutes for the others.

## Deployment prerequisites

Before installing the schedule:

1. Follow the [phased PostgreSQL migration procedure](#postgresql-migration-phase-and-rollback-safety). A
   live database below migration 048 must run `pre_roll`, deploy the scope-compatible application,
   and only then run `post_roll`; unqualified `db:migrate` and `db:setup` apply every pending file.
   Then apply through `054_general_app_runtime_owner_boundary.sql` using only the separate migration
   principal and the historical migration time zone that created the existing audit partitions.
   The restricted task supplies `MIGRATION_DATABASE_URL` but not runtime database credentials:

   ```bash
   NODE_ENV=production pnpm db:migrate
   NODE_ENV=production pnpm db:migrate --status --json
   ```

   Completion requires `state: "in_sync"`, head 054, 50 applied files, and empty `pending`, `drift`,
   and `unknown` arrays. Never run `scripts/ci/bootstrap-authoritative-budget-migration-role.ts` in
   production; it is fixed to disposable CI identities.

2. Provision the general application login before deploying the image. `DATABASE_URL` must identify
   an ordinary `LOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`
   principal whose only outbound membership is the fixed `pylva_general_app_runtime` owner group
   with no ADMIN or SET option. The only permitted reverse member is PostgreSQL's non-inheriting,
   no-SET creator-admin edge to the migrator. Use `GENERAL_APP_DATABASE_URL` only as a provisioning
   input for that same principal; do not inject it into the application container.
3. Before deploying the image, provision `BUDGET_CONTROL_DATABASE_URL` with the transactional
   provisioner below. Do not replace it with a raw `GRANT`: the provisioner repairs password,
   memberships, owner-scoped ACLs, database `CONNECT`, and complete fail-closed posture in one
   transaction. The expiry route never uses the general application or migration connection.
4. Confirm production role attestation and an env-bound expiry call succeed through
   `pylva_budget_expiry_actionable_builders(uuid, integer)` while a direct cross-tenant reservation
   scan and `SET ROLE pylva_budget_expiry_discovery_owner` both fail.
5. Confirm the general login can complete the real pre-tenant authentication/API-key bootstrap and
   ordinary tenant CRUD, can call `pylva_ensure_audit_log_partition(date)`, and cannot read or mutate
   any authoritative/control relation or sequence.
6. Create distinct general, projector, and provisioning-admin ClickHouse users, then run the exact
   RBAC provisioning command below. Production URLs must be credential-bearing `https://` URLs.
7. Deploy the matching application image.
8. Set a unique `CRON_SECRET` of at least 32 characters in the application and scheduler secret stores.
9. Verify the application health endpoint and one authenticated manual request to each scheduled
   route.

Pylva's public repository intentionally does not own Pylva Cloud AWS deployment authority. The hosted EventBridge/ECS target belongs in the private deployment overlay. A self-hosted operator must configure the equivalent scheduler in their platform.

Provision the budget runtime from a restricted task after migration 054 and after the general login:

```bash
NODE_ENV=production \
MIGRATION_DATABASE_URL='postgresql://<migrator>:<password>@<host>:5432/<database>' \
BUDGET_CONTROL_DATABASE_URL='postgresql://<budget-runtime>:<password>@<host>:5432/<database>' \
pnpm exec tsx scripts/ci/provision-authoritative-budget-runtime.ts
```

Require exit zero and `AUTHORITATIVE_BUDGET_RUNTIME_PROVISIONED`. The deployment overlay must supply
this as a reviewed restricted one-off task built from the approved candidate SHA; neither PostgreSQL
provisioner is currently packaged in the public production Docker targets. Do not inject
`MIGRATION_DATABASE_URL` into the application container.

## Application and provider trust boundary

The in-process SDK is a cooperative integration boundary. It can stop supported calls that the
application routes through controlled wrappers or helpers, but it cannot police code that holds a
provider credential and unrestricted provider egress. Python code in the same interpreter can also
introspect or monkeypatch library state. If plugins, tenants, agents, or other application code are
adversarial, keep reusable provider credentials and outbound provider access outside that process.
Route provider traffic through a trusted proxy or control plane that owns
reserve/dispatch/settle, and enforce the boundary with secret isolation and network policy.

Python `AsyncOpenAI` and `AsyncAnthropic` controlled facades and their streams are bound to their
first operational event loop. Run later operations and shutdown on that same loop; wrong-loop use
fails locally as `invalid_client`. During graceful worker termination, stop accepting new work,
close or cancel every live controlled stream/manager, await the controlled facade's `close()`, and
only then tear down the owner loop. The SDK schedules exact-once raw provider-stream shutdown before
the first cancellation point on a stream failure, but that cleanup still requires the owner loop to
remain alive until it completes.

## ClickHouse RBAC provisioning

The users must already exist through the deployment's secret-management path; this command never
places passwords in SQL. URL-encode password characters that are not URL-safe, and do not commit
these values:

The public application and migration Docker targets do not contain this provisioner. Run it only
from a deployment-owned, restricted one-off tool built from the approved candidate SHA, and record
the tool/image digest, access-control scope, redacted principals, exit status, and success marker.

```bash
CLICKHOUSE_ADMIN_URL='https://<provisioning-admin>:<password>@<clickhouse-host>:8443/pylva' \
CLICKHOUSE_URL='https://<general-app>:<password>@<clickhouse-host>:8443/pylva' \
BUDGET_PROJECTION_CLICKHOUSE_URL='https://<budget-projector>:<password>@<clickhouse-host>:8443/pylva' \
pnpm clickhouse:provision-budget-rbac
```

The command is idempotent and fail-closed. It replaces the two application users' grants with the
fixed `pylva_general_app_runtime` and `pylva_authoritative_budget_projector` role contracts, removes
stale assignments of those roles, revokes authoritative-table `INSERT` from every other user and
role, and audits the ClickHouse grant catalogs at column specificity. Only the fixed projector role
and the named provisioning admin remain authoritative writers. The admin is an explicit break-glass
exception and must not be used by an application or scheduler.

Run the command against every independently managed ClickHouse access-control scope used by the
deployment, before deploying the application and after every user, role, or grant change. It then
logs in through both application URLs and proves their exact active/default role and grant sets.
Provisioning fails without printing driver errors or credential-bearing URLs.

The command is convergent, but its ClickHouse admin statements are not one cross-statement
transaction. A non-zero exit can leave that access-control scope partially changed but not attested.
Keep deployment and projection blocked, diagnose through credential-safe provider logs, and rerun
the same command until it exits zero and prints exactly
`Authoritative budget ClickHouse RBAC provisioned and validated.` Never recover by manually granting
authoritative INSERT to an application principal; the successful rerun must perform the exclusive
writer audit and both application-login validations.

Production application and admin URLs using plain HTTP are rejected. The effective lifetime of one
successful application-role attestation must be no more than five seconds across the complete client
and posture cache stack. A failed posture is not cached, so a repaired grant can recover on the next
worker attempt without an application restart. The runtime attestation complements, but does not
replace, the admin-level catalog audit above.

> Current source blocker (2026-07-17): the projector client cache and posture cache each apply a
> five-second lifetime independently, so one attestation can authorize use for almost ten seconds.
> Do not approve the drift-detection gate until the implementation enforces one shared end-to-end
> expiry and the composed regression proves it.

## Temporary PostgreSQL general-app owner bridge

Migration 054 assigns the exact pre-authoritative application allowlist to the fixed
`NOLOGIN NOINHERIT` PostgreSQL role `pylva_general_app_runtime`. The separately provisioned
`DATABASE_URL` login inherits that group automatically but cannot `SET ROLE`, administer the group,
or reach the migration or budget-runtime roles. The group has no ownership or ACL on the nine
authoritative/control tables or their sequence. The migration ledger remains migration-owned and is
read-only to the group.

This boundary is intentionally temporary. It preserves pre-tenant bootstrap and legacy maintenance
behavior, so the group still has legacy owner bypass and `CREATE` on `public`; do not describe it as
a fully least-privileged non-owner application. The migration principal must be able to normalize
every existing allowlisted owner. If migration 054 reports an ownership precondition failure, repair
the prior ownership chain and retry. Never grant the application login `SUPERUSER`, `BYPASSRLS`,
`CREATEROLE`, ADMIN, SET, or migration-role membership to make the migration pass.

The daily audit runway route uses the group-owned
`pylva_ensure_audit_log_partition(date)` `SECURITY DEFINER` routine. It derives the name and exact
monthly identifier from a validated UTC calendar-month input, allows only the current UTC month
through twelve months ahead, serializes concurrent creation, and rejects a colliding object or
mismatched owner/bounds. Its `TIMESTAMPTZ` bound instants are not forced to UTC. Migration 054
captures and pins the historical zone from its migration session so the new runway continues the
frozen migration partitions without gaps or overlaps. Apply the upgrade with the time zone that
created the existing runway; a mismatched interpretation fails closed and must be resolved before
retrying. PUBLIC cannot execute the function. The application's inherited owner power remains a
compatibility concession around this bounded route; the future fully non-owner design must replace
any remaining owner-only maintenance with similarly narrow routines before removing the group
membership and restoring stronger RLS posture.

## Scheduler contract

Invoke one of these equivalent endpoints at least once per minute:

```text
POST /api/cron/expire-budget-reservations
GET  /api/cron/expire-budget-reservations
Authorization: Bearer <CRON_SECRET>
```

Invoke the projector on the same cadence:

```text
POST /api/cron/project-budget-cost-events
GET  /api/cron/project-budget-cost-events
Authorization: Bearer <CRON_SECRET>
```

Invoke the audit-partition runway daily:

```text
POST /api/cron/ensure-audit-partitions
GET  /api/cron/ensure-audit-partitions
Authorization: Bearer <CRON_SECRET>
```

Example manual probe:

```bash
curl --fail-with-body \
  --request POST \
  --header "Authorization: Bearer ${CRON_SECRET}" \
  "${PYLVA_BACKEND_URL}/api/cron/expire-budget-reservations"

curl --fail-with-body \
  --request POST \
  --header "Authorization: Bearer ${CRON_SECRET}" \
  "${PYLVA_BACKEND_URL}/api/cron/project-budget-cost-events"

curl --fail-with-body \
  --request POST \
  --header "Authorization: Bearer ${CRON_SECRET}" \
  "${PYLVA_BACKEND_URL}/api/cron/ensure-audit-partitions"
```

Keep all three schedules active after installation, including while `ENABLE_AUTHORITATIVE_BUDGET_CONTROL=false`.
That flag stops new holds; it must not strand reservations or committed outbox rows, and it does not
maintain the audit partition runway. All three routes remain protected by `CRON_SECRET` and never
accept tenant context from the request.

Concurrent or retried ticks are safe: tenant-local work uses `FOR UPDATE SKIP LOCKED` and lifecycle transitions are idempotent. Configure one ordinary in-flight invocation when the scheduler supports it to reduce needless database pressure; correctness does not depend on exclusive scheduler ownership.

## Bounded expiry work

The runner:

- discovers only builders with due reservations through bounded UUID-keyset pages from
  `pylva_budget_expiry_actionable_builders`; it never scans the parent builders table;
- opens a separate transaction-local RLS context for every builder;
- processes five builders concurrently by default, with a hard maximum of 25;
- processes at most 100 expired reservations per builder in one tick; and
- logs an opaque builder fingerprint and error class, never exception messages, credentials, reservation payloads, or tenant UUIDs.

If one tenant has more than 100 due reservations, later scheduled ticks drain the backlog. Monitor sustained backlog and runtime before changing these compile-time safety bounds.

## Bounded projection work

The projector:

- discovers only builders with actionable outbox or reconciliation rows through
  `pylva_budget_projection_actionable_builders`, using pages of 250 by default and never more than
  1,000;
- processes five builders concurrently by default, with a hard maximum of 25 and a separate
  transaction-local tenant context for each builder;
- recovers at most 100 expired leases and claims at most 50 events per builder per tick (hard claim
  maximum 100);
- projects five events concurrently by default, with a hard maximum of 20;
- reconciles at most 200 projected rows per builder per tick, with a hard maximum of 500; and
- creates a unique worker-incarnation identity for every run, exposes only its opaque hash, and
  predicates every outbox transition on the expected owner, status, attempt, and lease boundary.

Larger backlogs drain over later ticks. A retryable per-event failure is rescheduled with bounded
metadata; a lost acknowledgement is verified against the immutable ClickHouse identity before the
PostgreSQL row becomes verified. Conflicts, invalid payloads, exhausted rows, and reconciliation
failures remain visible and never become billable closure.

## Status and alert semantics

Every response carries `Cache-Control: no-store`.

| Worker / result            | Meaning                                                                                                                    | Operator action                                             |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Any `401`                  | Missing, mismatched, or unset `CRON_SECRET`                                                                                | Fix secret delivery; do not weaken authentication           |
| Expiry `200`, `errors: 0`  | All scanned tenants completed                                                                                              | Record success                                              |
| Expiry `200`, `errors > 0` | Partial progress; failed tenants remain retryable on the next tick                                                         | Alert on recurrence and investigate by opaque log reference |
| Expiry `500`               | Enumeration crashed or every scanned tenant failed                                                                         | Retry with backoff and page immediately if persistent       |
| Projection `200`           | The cycle completed without a systemic or reconciliation alarm; bounded retry rows may remain for later ticks              | Monitor backlog and retry trend                             |
| Projection `500`           | The cycle crashed, failed systemically, found high/exhausted attempts, or found missing/conflicting/errored reconciliation | Retry with backoff and page immediately if persistent       |
| Audit runway `200`         | Every requested partition already existed safely or was created through the bounded function                               | Record success                                              |
| Audit runway `500`         | At least one partition was missing, invalid, unsafe, or could not be created                                               | Retry and page before the current runway can expire         |

The authenticated cron route is not subject to the public SDK-key rate bucket. If an upstream proxy independently returns `429`, treat it as an infrastructure failure and retry with backoff. SDK budget-control endpoints have a separate per-key limit of 600 requests per 60 seconds; their `401`, `429`, and `5xx` responses are also non-cacheable.

Minimum alerts:

- any non-2xx scheduler response;
- repeated `errors > 0` results;
- repeated runs expiring the full per-builder batch, which indicates backlog;
- cron duration approaching the scheduler or load-balancer timeout; and
- absence of a successful tick for more than two schedule intervals.

For projection, also alert on any reconciliation missing/conflict/error count, exhausted or
high-attempt row, systemic worker failure, or non-zero backlog that does not decline across ticks.
Credential or posture errors must be repaired at the dedicated projector identity; never restore
service by granting authoritative INSERT to the general ClickHouse principal.

## PostgreSQL migration and posture recovery

If migration 054 fails, its SQL and migration-ledger insert roll back together; earlier successfully
applied migrations remain applied. Run `NODE_ENV=production pnpm db:migrate --status --json`,
preserve the failure evidence, and leave 054 pending. Repair the reported ownership path or restore
the historical migration `TimeZone`, then rerun the normal migration command. Never edit
`schema_migrations`, baseline an already tracked database, modify a frozen migration, or downgrade
050–054 as recovery.

For repairable general-login or budget-login drift, rerun the corresponding transactional
provisioner. If both identities require repair, provision the general login first because the budget
provisioner uses the migrator's sealed `SET ROLE pylva_general_app_runtime` edge for owner-scoped ACL
cleanup. Protected attributes, direct routine grants, or ownership that the ordinary migrator cannot
repair require an authorized break-glass administrator; after that narrow repair, rerun the
provisioner and require its exact success marker.

After any PostgreSQL role, membership, ACL, username, URL, or password repair, restart every
application and worker instance so deterministic production posture is freshly attested. Keep the
feature flag false if new reservations must stop, but retain the dedicated identities and keep
commit, release, expiry, projection, and audit schedules running until outstanding work drains.

## Local real-service evidence boundary

A local run is diagnostic evidence, not a frozen candidate, GitHub run, release, or production
rehearsal. Record the exact Git SHA and dirty state, runtime/service versions, server time zones,
redacted role identities, artifact SHA-256 values, exact commands/result counts, and cleanup outcome.
Follow the service setup and test order from
`.github/workflows/authoritative-budget-control-ci.yml` at that SHA; an ad hoc subset must not inherit
the workflow's aggregate counts or artifact claims.
