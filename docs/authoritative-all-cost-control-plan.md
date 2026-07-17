# Pylva Authoritative All-Cost Control Plan

Status: **Core local enforcement validated; independent QA found release-blocking implementation, test, CI, and operations gaps**

Last updated: 2026-07-17

This is the live implementation and verification ledger for authoritative LLM and non-LLM cost control across the Pylva backend, Python SDK, TypeScript SDK, and dashboard. A workstream is marked complete only after its implementation, focused tests, cross-contract checks, and applicable build/type/lint gates all pass.

## Goal and guarantee

Every controlled paid action follows this lifecycle:

```text
Reserve bounded usage
→ Allow or refuse atomically
→ Call the provider only when allowed
→ Commit actual usage, release known-unused capacity, or retain unresolved capacity
→ Display the decision and resulting cost exactly once
```

PostgreSQL is the authoritative control ledger. ClickHouse remains the analytics projection. Redis may cache or transport realtime messages, but Redis failure must not weaken control correctness.

The eventual public guarantee is:

> Pylva atomically controls supported wrapped LLM requests and non-LLM operations executed through its reservation API. When authorization is refused, the provider is not called.

That guarantee applies only when control mode is `enforce`, authoritative pricing and a conservative usage bound exist, and every paid path is routed through a supported wrapper or reservation helper. Legacy `reportUsage()` and `report_usage()` remain tracking-only.

This is an integration guarantee, not a same-process sandbox. Any caller that possesses provider
credentials and provider egress can bypass an in-process SDK by sending an unwrapped request; Python
also permits deliberate function-global/closure/module introspection and monkeypatching. Adversarial
enforcement therefore requires provider credentials and provider egress to be isolated from
application code behind a trusted proxy or control-plane boundary. D095 records the exact scope.

## Progress ledger

|   # | Workstream                                                      | Source status | Completion evidence or remaining closure                                                                                                                                                            |
| --: | --------------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|   0 | Baseline audit, plan, and decision log                          | Complete      | The historical ledger is preserved, the 2026-07-17 QA is reconciled, and durable lessons D100–D114 distinguish produced evidence from readiness claims.                                             |
|   1 | Shared wire contract and golden fixtures                        | Test closure  | The corpus currently contains 150 unique fixtures and replays cross-language, but no harness pins the required exact count and privacy coverage is structural rather than secret-content detection. |
|   2 | Authoritative PostgreSQL ledger and migrations                  | Complete      | Frozen migrations 050–054, fresh/replay/raw-054 migration proof, exact role postures, provisioners, physical verification, and cleanup pass.                                                        |
|   3 | Reserve/commit/release/extend backend API                       | Needs fix     | Core lifecycle passes, but capabilities exposes the internal trusted-header contract and the API-key database-exception path lacks a sanitized regression.                                          |
|   4 | Durable analytics projection and reconciliation                 | Needs fix     | Projection and recovery pass, but daily reconciliation casts date-only bounds in the server timezone and two nested five-second caches can extend drift reuse to almost ten seconds.                |
|   5 | TypeScript SDK readiness and reservation client                 | Local pass    | Source passes 922/922 and the frozen tarball passes local package gates; remaining lifecycle edge regressions and remote exact-SHA evidence are still required.                                     |
|   6 | Python SDK readiness and reservation client                     | Needs fix     | Source passes 705/705 and frozen local artifacts pass, but unhashable malformed `ControlConfig` values can raise native `TypeError` instead of `InvalidControlConfigError`.                         |
|   7 | LLM provider wrapper enforcement                                | Test closure  | Supported strict paths are strong; remaining observer-order, finalizer-registration, and streaming wrapper-plus-callback edge cases need explicit regressions.                                      |
|   8 | Non-LLM controlled usage and first adapter                      | Test closure  | Generic and Tavily paths pass locally; direct backend denial, async parity, and official Tavily dependency/version compatibility are not yet release evidence.                                      |
|   9 | LangGraph ownership and telemetry deduplication                 | CI/test gap   | Local 4/4 service evidence passes, but unexpected network escape is not fail-closed and the service assertion omits span/parent-span plus streaming wrapper/callback coverage.                      |
|  10 | Dashboard budget activity and cost precision                    | Needs fix     | Budget Activity works, but Cost Sources reads authority tables through the denied general login, raw exception messages reach logs, and expiry-created unresolved activity lacks an API/UI journey. |
|  11 | Cross-SDK, concurrency, chaos, and compatibility suite          | Local/CI gap  | Local chaos passes 11/11, but focused CI independently rebuilds Python artifacts for chaos and LangGraph instead of consuming one hash-addressed candidate.                                         |
|  12 | Opt-in rollout, packaging, documentation, and release readiness | Blocked       | Release workflows do not attest every required repository workflow, security coverage is incomplete, npm prereleases lack a non-latest tag, and no production readiness operator command exists.    |

`Local pass` records a produced local result only. `Needs fix`, `Test closure`, `CI/test gap`, and
`Blocked` are release-blocking statuses under this plan's completion rule. A frozen commit on
`main`, green GitHub run URLs, production scheduler rehearsal, full shadow comparison, internal
canary, and release-owner approval remain mandatory after the source blockers are closed.

## Independent QA reconciliation — 2026-07-17

The independent full-system audit confirmed that the core authority is substantial and functional:

- root Vitest: 3,457 passed and 8 skipped across 317 passed files and 1 skipped file;
- TypeScript SDK: 922/922; Python SDK: 705/705; frontend: 129/129;
- root typecheck, lint, production build, performance budget, and license checks passed;
- migration runner 12/12, runtime-role migration 12/12, PostgreSQL authority 230/230,
  provisioner/owner-boundary 24/24, concurrency/lifecycle/load 29/29, and real projection 26/26; and
- the exact TypeScript tarball `776c4e…abf3` and Python wheel `f26aea…d74d` passed local
  cross-runtime chaos 11/11 and LangGraph 4/4.

The repository-wide Prettier check still reports 56 older unchanged files; every modified or new
TypeScript, JavaScript, CSS, and JSON file in this implementation passes its scoped format check.
PostgreSQL 16, ClickHouse 24.8, remote GitHub jobs, registry publication, deployment, shadow/canary,
and production activation remain unverified in this local record.

Those passes do not override source review. Confirmed blockers include the Cost Sources production
credential violation, unsanitized capability/log errors, a non-UTC reconciliation boundary, an
effective ClickHouse posture-cache window longer than five seconds, malformed Python configuration
escaping through `TypeError`, non-immutable Python CI service artifacts, permissive LangGraph test
network escape, and incomplete release/operations automation. Stable publication and activation
remain blocked until each item is fixed and its regression is part of the required exact-SHA CI
evidence. The release checklist is the actionable blocker ledger.

The workstream evidence below is a chronological engineering record. Statements such as “complete,”
“final,” or “no remaining finding” describe the review point at which they were written; they do not
override the current progress ledger or the 2026-07-17 reconciliation.

## Baseline evidence

Baseline audit completed on 2026-07-13 against the repository as it existed before authoritative-control implementation:

- Python SDK: `243 passed` with `PYTHONPATH=packages/sdk-py`; Ruff passed; strict mypy passed across 34 source files.
- TypeScript: the dependency tree is incomplete because the local APFS volume is full (`ENOSPC`). The baseline TypeScript test/type/build gates could not be executed and remain mandatory for every affected implementation workstream.
- Service-backed suites: Docker is not installed locally, so the repository's Compose harness is unavailable. PostgreSQL 17.7, Redis 8.8, and a ClickHouse 26.5 server-capable binary are installed; implementation workstreams will run them on isolated local data directories and ports. CI/Compose parity remains a release gate, and mocks do not replace the local real-service tests.
- Python environment: an unrelated checkout is installed globally as `pylva` 1.0.2. All repository validation must use a clean environment or explicitly set `PYTHONPATH=packages/sdk-py`.
- Compatibility conflict: legacy local budget enforcement refuses when accumulated spend is equal to the limit. The versioned authoritative reservation contract allows exact equality. Legacy behavior stays unchanged; enforcement mode uses only the authoritative rule.

Workstream 0 is complete because the audit and its limitations are fully recorded. Those historical
ENOSPC and local-container limitations were not waived: disk was recovered, the TypeScript and
packaging gates were run, PostgreSQL 17 and ClickHouse 26.5 were exercised locally, and the focused
CI workflow pins PostgreSQL 16/17 and ClickHouse 24.8/26.5. PostgreSQL 16 remains CI-only on this Mac.

## Workstream 1 evidence

Completed on 2026-07-13 after an independent critical review returned GO with no remaining P0, P1, or P2 findings.

- `tests/contracts/budget-control-contract.json` is strict, `jq`-parseable JSON with 150 uniquely named fixtures. Every schema has a valid example; the manifest proves coverage of all public decisions, response lifecycle states, frameworks, provider-attempt statuses, rule periods, error codes, uppercase-to-lowercase UUID normalization, honest shadow unavailability, widened post-provider cost evidence, and cross-runtime negative-zero normalization.
- The same corpus passes through the shared/backend schema boundary and TypeScript SDK boundary. The focused TypeScript contract and hardening suites pass 330 checks, including package-root fixture resolution, reason-specific bypass identities, empty-warning invariants for unevaluated bypasses, exact `NUMERIC(44,18)` commit arithmetic, and negative-zero normalization.
- Python passes all 151 focused contract cases with the same semantics. An isolated Pydantic 2.5.0 environment also passed the minimum-dependency control-contract gate, which CI pins.
- The current full TypeScript SDK baseline passes 351 tests. The last pre-client full Python SDK baseline passed 393 tests; Workstream 6 owns its expanded post-client rerun and packaging matrix.
- Shared and TypeScript SDK compilation pass, including a strict standalone compile of both contract harnesses. Ruff passes the entire Python SDK and test tree; strict mypy passes all 35 Python source files.
- Exact fixed-scale response arithmetic, exact-limit semantics, canonical decimals, millisecond UTC timestamps, integral JSON number normalization, Unicode scalar length/blank/surrogate handling, omitted error fields, strict request privacy, and additive response compatibility all have cross-language fixtures.
- Public lifecycle/configuration exports remain intentionally owned by Workstreams 5 and 6; Workstream 1 establishes their versioned wire and runtime-validation contract without prematurely changing SDK root APIs.

## Workstream 2 evidence

The migration-050 ledger foundation completed on 2026-07-13 after independent closure,
global-revision, outbox, and schema-security reviews returned GO with no open Workstream 2 P0, P1,
or P2 findings. Migration `050_authoritative_budget_control_ledger.sql` is frozen at SHA-256
`3bd8b69ef1b09814e6cc0645b2eb188504fc84b4e15abbe5e42ddf704619218e`. Later forward-only role and
compatibility migrations are tracked separately below.

The migration has seven tenant-owned ledger tables, including immutable builder-wide rule revisions over stable accumulator accounts, fixed-scale public and per-operation arithmetic, an unbounded internal committed-spend accumulator, forced RLS, tenant-composite relationships, immutable canonical snapshots, serialized allocation authorization, gap-free lifecycle transitions, authoritative usage/outbox closure, and coordinated retention tombstones. PostgreSQL derives account postings from allocation state changes and derives the analytics payload from authoritative usage rather than trusting a second client-authored cost record.

Fresh adversarial reviews materially strengthened this design. They found and drove fixes for PostgreSQL `NUMERIC NaN`, stale account snapshots, cross-customer/period account substitution, contradictory replay snapshots, expired-lease revival, missing transactional outbox rows, independent counter tampering, infinite worker leases, and retention cleanup that would otherwise destroy exactly-once identities.

The ledger now normalizes accepted UUID strings to lowercase before hashing while PostgreSQL compares UUID-bearing JSON semantically rather than by text case. Lifecycle timestamps are server-owned. Outbox work uses server-timed, expiring leases owned by an identified worker. A reservation snapshots every active target-applicable global rule revision and must contain exactly one allocation for each revision against a still-current account period; missing materialization fails closed. Zero-dollar authorization still consumes an account version, while a later zero-to-zero settlement does not create a phantom account-version increment. Posting counters may change only through the allocation trigger; an explicit closure function supports reconciliation and corruption audits without scanning account history on every write. Ledger authority is retained by restricting builder deletion while dependent ledger rows or coordinated tombstones remain.

Completion evidence:

- The real-PostgreSQL migration suite passes **106/106**, including three consecutive root reruns after the lease-renewal timing fix; tenant isolation passes **11/11**; and transactional DDL apply/rollback parsing passes.
- The exact Drizzle mirror passes **10/10**. It covers all seven tables and the global revision/account/reservation/allocation relationships.
- Historical migration-050 closure snapshot, not current-head counts: the physical verifier modeled
  7 tables, 192 columns, 80 CHECK fingerprints, 33 helper fingerprints/configurations, 22 keys, 12
  foreign keys, 26 custom indexes plus the account `NULLS NOT DISTINCT` identity, and 18 triggers.
  Its then-current unit suite passed **24/24**. A fresh migration-050 PostgreSQL database verified
  every category as `ok`; deliberate helper-body drift exited non-zero and identified the changed
  helper. Current migration-054 counts and results are recorded in the final validation ledger.
- All 33 authoritative helpers pin `search_path`. Canonical JSON/decimal/UUID/timestamp rules, blank/control Unicode rules, server-owned lifecycle time, exact revision-set closure, and monotonic bounded outbox leases are regression-tested.
- The generated manifest records frozen migrations `050` through `054`. Forward-only migration
  `054_general_app_runtime_owner_boundary.sql` is the current manifest head and brings the total to
  50 PostgreSQL migrations. Its frozen SHA-256 is
  `f6e3be6b0a190f00a2f620fdacbacbb34cdbfcc522a9d138a59e1142b7cd8dbb`.
  All 13 protected relations keep RLS enabled; the nine authoritative/control tables remain FORCEd,
  while `builders`, `rules`, `cost_sources`, and `custom_pricing` retain the documented legacy owner
  bypass through the temporary fixed general-app owner group.
- Targeted strict TypeScript, ESLint using the repository-identical full dependency config, Prettier, and `git diff --check` all pass for Workstream 2 files.

Workstreams 3, 4, and 11 subsequently closed the multi-account lock ordering, globally unique worker
identity, lost-ack projection, exact runtime-role, and high-cardinality materialization gates. Values
that cannot fit the public pre-dispatch `NUMERIC(38,18)` representation fail unavailable, while
post-provider actual-cost and overage evidence uses the additive `NUMERIC(44,18)` boundary without
changing frozen migration `050`.

## Workstream 3 evidence — backend control closure

The production-client JSONB regression was fixed and independently re-audited. Every dynamic raw
authoritative JSONB binding now passes validated text through `::TEXT::JSONB`, independent of
postgres.js serializers that Drizzle may mutate. Real shared-application and authoritative-pool rule
tests create/update exact objects and immutable revisions, prove rollback/retry/concurrency behavior,
and pass 21/21 even with hostile ambient migration credentials. The broader JSON boundary suite
passes 51/51, and the final audit found no remaining P0/P1/P2 raw-binding defect.

The five SDK-key control routes authenticate before dashboard fallback, replace spoofable tenant
headers with the API-key identity, and use a dedicated 600-request-per-minute hot-path bucket. The
four mutation routes return non-cacheable sanitized missing-context failures; capabilities does not
yet meet that behavior and remains release-blocking. Reserve, commit, release, extend, expiry, late
commit, exact backfill, rule rotation, pricing, overage, duplicate retry, and conflicting terminal
transitions pass unit and real-PostgreSQL suites. A 100-way `$0.10` race against `$1` repeatedly
allows exactly ten; high-cardinality first use remains inside the recorded load budgets.

Migrations are frozen at:

- `050_authoritative_budget_control_ledger.sql` —
  `3bd8b69ef1b09814e6cc0645b2eb188504fc84b4e15abbe5e42ddf704619218e`;
- `051_authoritative_budget_control_runtime.sql` —
  `3fabbc1236e562eddd1b83e4c8826abfb61d0eca73b8e4773b10d94599055af8`;
- `052_authoritative_budget_control_runtime_roles.sql` —
  `3cc7efe258ceb49e9fd56789c3fdb9a0f6cd76e990d5f5681ecc24cde4172be6`; and
- `053_legacy_catalog_owner_rls_compatibility.sql` —
  `ba598fab2d79316926ebce3e853c61a1408dae14cd4bb40a0a572f0a90bb431f`.

Migration 053 leaves RLS enabled on all four legacy catalogs but removes FORCE so the
NOSUPER/NOBYPASS table owner can complete existing authentication and bootstrap reads/writes before
a tenant GUC exists. The dedicated budget runtime remains a non-owner of all 13 protected relations,
and its attestor requires the exact 9-FORCE/4-NO FORCE split rather than shrinking the protected set.

Forward-only migration `054_general_app_runtime_owner_boundary.sql` is now the current schema and
manifest head, making 50 PostgreSQL migrations in total. Its frozen SHA-256 is
`f6e3be6b0a190f00a2f620fdacbacbb34cdbfcc522a9d138a59e1142b7cd8dbb`. It creates the fixed
`NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS` `pylva_general_app_runtime` owner group, transfers only
the explicit legacy relation/view/sequence/function allowlist, and leaves the authority ledger,
authority sequence, migration ledger, and migration-only backup outside that ownership boundary. A
separately provisioned ordinary application login inherits only this group with no ADMIN or SET
option. A bounded group-owned `pylva_ensure_audit_log_partition(date)` definer creates only the exact
current-through-plus-12-month UTC calendar runway, while casting its `TIMESTAMPTZ` bound instants in
the captured historical migration time zone rather than forcing UTC. Migration 054 rejects existing
bounds that do not match that pinned zone, preventing a silent gap or overlap; upgrade operators must
apply it using the zone that created the existing runway. The separate migrator and dedicated budget
runtime retain their distinct responsibilities and credentials.

This owner group is a temporary compatibility bridge, not the target trust model. It preserves
pre-tenant authentication, API-key, legacy CRUD, and maintenance paths without serving traffic as
the migration role, but it also deliberately retains legacy owner bypass and schema `CREATE` for the
general application. Migration apply fails closed when the migrator cannot normalize every existing
allowlisted owner. The future goal is a fully non-owner general login with exact ACLs, complete tenant
context, FORCE RLS where appropriate, and narrowly bounded definer functions for the remaining
owner-only maintenance operations.

At migration-053 closure, a fresh PostgreSQL 17 database applied the then-current full manifest, a
second application was a no-op, and the text and JSON physical verifiers reported every modeled
object in sync on repeat runs. The dedicated runtime identity was
NOSUPER/NOBYPASS/NOCREATEDB/NOCREATEROLE/NOREPLICATION, owned no protected object, could not
cross-tenant scan or assume either discovery owner, and could use only the bounded projection and
expiry discovery functions. A real PostgreSQL owner/runtime regression proved owner bootstrap
access without a tenant GUC, tenant isolation for the dedicated runtime, and FORCE RLS on all nine
authority tables. PostgreSQL 16 and 17 remain explicit CI matrix legs.

Historical migration-053 closure passed 80/80 focused posture/verifier/manifest/source checks, all 87 database
schema/manifest checks, the 12/12 real PostgreSQL runtime-role suite, and the 9/9 migration-runner
suite. A fresh PostgreSQL 17 database applied all 49 migrations through 053, replayed with zero
pending work, and passed the text verifier twice plus the JSON verifier with empty RLS
missing/unexpected/invalid sets and every runtime-security boolean true.

Those migration-053 numbers are retained as historical evidence only. The migration-054 closure now
passes a clean 50-migration PostgreSQL 17 apply, immediate no-op replay, manifest and text/JSON
physical verification, both runtime postures, ordinary-login seed/bootstrap, pre-GUC auth/API-key
behavior, tenant CRUD, bounded audit partition creation/drop, and general-app authority denial. The
budget-login provisioner also passes real two-owner drift repair plus hostile third-owner and missing
general-owner-edge rollback tests. Exact commands, service identities, counts, captured historical
time-zone coverage, and the fail-closed mismatched-bound upgrade case are consolidated in the final
validation ledger below rather than copied from migration-053 evidence.

The final general-app provisioner lane passes 17/17 real PostgreSQL adversarial cases and 15/15
static, topology, and CI contracts. It rejects the fixed owner group when supplied as the application
login and rejects any pre-existing `NOLOGIN` target instead of repurposing an unknown group identity.
A legitimate existing `LOGIN` remains transactionally repairable only inside the closed ownership,
ACL, membership, attribute, and rollback posture recorded in D078, D079, and D091.

Production boot now attests the dedicated PostgreSQL and ClickHouse identities independently of the
new-reservation feature flag. This matches the real dependency boundary: rule mutation, settlement,
expiry, and previously committed projection work continue while new reservations are disabled. A
missing identity makes production instrumentation unhealthy with only a sanitized
`credential_missing` reason; local/test startup remains unaffected.

## Workstream 4 evidence — durable projection and billing closure

ClickHouse migration `011_authoritative_budget_projection.sql` adds the immutable authoritative table,
typed billing/analytics views, separate telemetry and billing retention, and canonical legacy-plus-
controlled reads. PostgreSQL outbox workers use unique incarnation IDs, fenced leases, bounded
recovery/claim/reconciliation batches, idempotent insert inspection, lost-ack recovery, and exact
payload-hash conflict detection. Billing remains closed until period authority and projection
verification agree; refused/reserved actions never enter usage or invoices.

The general ClickHouse identity is read-only for authoritative events. The projector has only the
fixed insert/inspect role, and the provisioning admin removes every other direct or nested writer.
The ClickHouse 26.5 local suites pass, including hostile unrelated and inherited-role writers
receiving actual authorization failures. The workflow defines a 24.8 floor leg, but no frozen-commit
run URL currently proves it. Production configuration requires distinct, password-bearing HTTPS
identities. Failed posture retries immediately, but nested five-second client and posture caches can
reuse one accepted attestation for almost ten seconds; the promised five-second end-to-end bound is
not yet met.

Most runtime ClickHouse timestamp boundaries bind UTC strings and parse them explicitly, and a
repository scan rejects native `DateTime` placeholders under `src`. Daily pricing reconciliation
still promotes date-only values through the server timezone and remains release-blocking. Fresh
schema 001 pins legacy event storage to `DateTime('UTC')`, while forward-only migration 012 adds that
annotation without changing existing epochs. A local ClickHouse 26.5 installation applies the
historical bare schema and every view through 011 under `Asia/Riyadh`, preserves the old epoch across
012, and proves a new timezone-free ingest has the correct UTC epoch and is visible in the canonical
window. The schema/unit/contract lane passes 47/47 and the real non-UTC migration lane passes 3/3;
these results do not replace the missing 24.8 CI record or the reconciliation fix.

## Workstreams 5 and 6 evidence — SDK control clients and artifacts

The earlier TypeScript 528-test/package run, its recorded gzip sizes, and the earlier Python
659-test wheel/sdist run are **superseded candidate evidence**, not final evidence. Both sources
changed afterward to close detached-request, paid-evidence, official-client identity, private
transport, fail-closed surface, and managed-model lifecycle gaps. Those old artifacts must not be
published, reused by clean-artifact integration, or copied into the final ledger.

The shared control clients, response validation, lifecycle ownership, runtime identity, exact
decimal handling, and renewed non-LLM snapshots remain green. The non-LLM adversarial snapshot lane
passes Python 41/41 and TypeScript 52/52 together with strict Mypy/Ruff and TypeScript
type/lint/format gates.

The pre-fix TypeScript source passed 909/909 tests and strict typecheck. One build produced one
`@pylva/sdk` 1.2.0 tarball, and no downstream gate rebuilt or repacked it. Its SHA-256 was
`428ce1e4462c495fb3f6585098680eff7d562230ee650fc580b9e9e44118832d`. That same byte sequence passed
the packed topology and embedded-source-map checks, optional-peer-free imports, the lowest mutually
installable strict floor, the repository-current profile, AI SDK 3/4/5 pre-dispatch refusal profiles,
official ESM/CJS/mixed-module requests and streams, cancellation and close barriers, cache-poison and
identity checks, and the five fixed complete-closure size gates. The measured gzip-once closures are
47,780 bytes for root, 24,848 for OpenAI, 24,878 for Anthropic, 20,184 for Vercel AI, and 15,051 for
LangGraph, all below D088's fixed caps. The floor graph pins `@langchain/core` 1.1.48 with LangGraph
1.0.0 because 1.0.0 is not a mutually installable core floor; supported old provider legs select the
official OpenAI and Anthropic web shims before provider/Pylva imports in every relevant module mode.

That hash is now **superseded candidate evidence, not the final TypeScript artifact**. A final diff
audit subsequently found a post-dispatch native-abort path that stopped consumer work without
stopping the authoritative reservation heartbeat. The source fix now passes 73/73 focused
reflection/lifecycle tests across five files and the expanded full 922/922 SDK suite. Source and
public typechecks, scoped ESLint, Prettier, and diff-check pass. During active consumption it observes
only exact caller/native-controller abort, subscribes idle live streams to facade close, stops and
detaches without fabricating commit or release after dispatch, and prevents a terminal observer from
restarting heartbeat or settling twice. Official-prototype ESM/CJS facades expose controlled
iteration, `toReadableStream`, and controller behavior while refusing raw peer iteration,
reflection, and unsafe `tee` access. The pre-fix hash must not be published or copied into the final
validation ledger as a release-ready artifact. The post-fix artifact proof follows.

That source was then built and packed. A package-documentation audit superseded the otherwise-green
D089 candidate because its embedded README did not match the final source README. The replacement
final local `@pylva/sdk` 1.2.0 tarball has SHA-256
`776c4e7683adbb7f276e837507c38728e2365e1dac228f11f02addd674edabf3`. The exact same bytes pass
artifact topology and embedded source maps, optional-peer-free imports, floor and current peer
profiles, AI SDK 3/4/5 refusal, official ESM/CJS/mixed stream, cancellation, close, cache-poison and
identity gates, and an attested outside-workspace current-peer install; the hash remains unchanged.
Its final gzip-once closures are 49,045/49,700 bytes for root, 25,367/25,900 for OpenAI,
25,392/25,900 for Anthropic, 20,184/21,000 for Vercel AI, and 15,051/15,700 for LangGraph. The exact
same replacement tarball later passed the final immutable cross-runtime chaos and LangGraph service
groups with the final Python wheel; no downstream rebuild or repack was substituted. D099 records
the package-documentation identity rule and replacement evidence.

The pre-fix Python direct-provider source passed 146 focused tests and the full 671-test SDK suite;
Ruff format/check and strict Mypy over 47 source files passed. Fresh wheel and sdist artifacts each
passed isolated installed-package smoke tests against both the declared floor and current provider
sets (OpenAI 2.45.0 and Anthropic 0.116.0 in both resolved environments), for four green artifact/
profile legs. Every leg proved six official sync/async provider requests, six authoritative
reservations and strict events, zero legacy events, canonical endpoint/auth posture, and no real
network escape. The pre-fix wheel SHA-256 is
`bd9fe0ff0822c932f615a40d28eb3785dce90a657fe3c98a56dc509d49a2675a`; the sdist SHA-256 is
`0316124537d3fd24ef2388841ff738d47e3208203b582dadd22f57ed2e8d4965`. The lifecycle race lane
additionally proved close-during-reserve across sync/async OpenAI/Anthropic paths produced four
releases, four exact correlated no-dispatch markers, and zero provider calls, commits, or local
fallback markers.

Those Python hashes are also **superseded candidate evidence, not final artifacts**. Final review
found a bounded idle-stream/facade-close path that could stop the consumer without stopping the
reservation heartbeat. The fix therefore required the full Python source gates, new wheel and sdist
builds, all four floor/current installed-package legs, and service journeys to rerun against the
replacement bytes; the completed replacement evidence follows. The old wheel environment passed
chaos and LangGraph alongside the superseded TypeScript tarball, but neither old SDK artifact may be
copied into the final release-readiness ledger.

Final post-fix Python source evidence passes 148/148 focused lifecycle/provider tests and 702 passed
plus 1 skipped across the complete SDK suite. Ruff lint and format pass across the package and tests,
strict Mypy passes across all 47 source files with the LangChain extra installed, and an independent
lifecycle review found no remaining P1/P2 issue. Stream and manager facades are narrow and slots-only
and do not forward ordinary public attributes exposing raw provider responses, clients, factories,
transports, credentials, or mutable lifecycle state. They close accidental/public API, copy/pickle,
and ordinary mutation paths; they are not claimed to resist hostile same-process introspection or
direct provider HTTP.

Facade close cancels every live post-dispatch lifecycle lease, stops its registered heartbeat, and
leaves the reservation unresolved without commit or release. Async OpenAI and Anthropic controlled
facades bind cooperatively to their first operational event loop. Later facade or stream use from a
different loop fails locally as `invalid_client`; applications must await facade and stream closure
before tearing down the owner loop. On async provider-stream failure, exact-once raw provider
shutdown is scheduled before the first cancellation point so caller cancellation cannot strand the
official stream after its finalizer and heartbeat have been detached.

The final local Python artifacts are:

- wheel:
  `/private/tmp/pylva-final-python-20260715-S9DgSw/dist/pylva_sdk-1.2.0-py3-none-any.whl`, SHA-256
  `f26aeacad94aa073c42c764968cb7b4d3361fb99f622e4cf20882fe36ff8d74d`;
- sdist: `/private/tmp/pylva-final-python-20260715-S9DgSw/dist/pylva_sdk-1.2.0.tar.gz`, SHA-256
  `8574d814089a243787e9ef751eaee8e39be7305f46db5eaf5daedb563eb20175`.

Archive inspection and all four installed profiles—wheel and sdist against the declared provider
floor and current sets, including official sync and async behavior—pass. Both hashes remained stable
before and after the matrix. The exact-wheel integration environment passes `pip check` under Python
3.12 with LangGraph 1.2.9, LangChain 1.3.13, OpenAI 2.45.0, and respx 0.23.1. An initial uv-managed
environment bootstrap aborted inside `ensurepip` with `SIGABRT` before installing or exercising the
artifact; the unchanged bytes then passed every leg using the installed framework Python 3.12. This
was a local environment bootstrap failure, not an SDK or artifact failure, and it does not replace
the still-pending remote Python 3.10–3.13 matrix.

Both SDKs keep 1.x defaults at `legacy` plus availability fallback. `ready`, reserve, commit, release,
and extend runtime-validate every response and never turn an unsupported or unavailable backend into
a fabricated authoritative allow decision.

## Workstreams 7 and 8 evidence — LLM and non-LLM enforcement

Explicit strict OpenAI and Anthropic wrappers in both SDKs and the TypeScript Vercel helper have the
required reserve/dispatch/settle structure, detached request snapshots, bounded paid-evidence rules,
private official transport isolation, lifecycle close barriers, and exact consumer observers. The
frozen TypeScript direct-provider source passes 57/57 on repository-current OpenAI 5.23.2 and
Anthropic 0.91.1 plus 48/48 and dual typecheck at the declared OpenAI 4.104.0 and Anthropic 0.30.1
floors, with unhandled network requests rejected. Its package metadata, lockfile, targeted lint, and
format gates pass. The final TypeScript tarball proves the managed-Vercel token, private provider
clients, shared errors, reset barriers, and ownership correlation remain physically unreachable and
single-identity across root/subpath plus mixed ESM/CJS imports. It also covers poisoned peer exports,
reflective surface access, caller mutation, cancellation, missing usage, extension failure, and
consumer exceptions. The final Python wheel/sdist matrix proves the corresponding official
sync/async OpenAI and Anthropic paths at the declared floor and current profiles. The immutable
two-SDK chaos and LangGraph service groups then consume the frozen package candidates, closing the
local Workstream 7 and 8 evidence without a source-tree or rebuilt-artifact substitution.

The managed-Vercel contract is frozen: its asynchronous official-model factory returns only an
opaque token, native ESM peer loading enforces AI SDK 6 and `@ai-sdk/openai` 3, and four focused
files pass 79 tests plus public type, scoped ESLint, and Prettier gates. The hash-addressed final
TypeScript package supplies the corresponding root/deep and mixed ESM/CJS identity proof.

Exact and bounded non-LLM helpers reserve before invoking the paid closure, commit exact quantity,
record bound violations rather than truncating them, and retain ambiguity after dispatch. The Tavily
adapter forces basic search, disables automatic upgrading, requires exact usage evidence, and rejects
cross-case passthrough aliases before reservation or provider invocation. Legacy `reportUsage()` and
`report_usage()` remain explicitly post-call tracking-only APIs.

## Workstream 9 evidence — LangGraph exact ownership

Callbacks are graph observers, while strict wrappers/controlled tools own reservation, settlement,
and billable telemetry. Exact async-safe correlation covers callback-first/provider-first ordering,
pre-dispatch refusal, nested/concurrent calls, identity reinitialization, orphan tasks, lost commit
acknowledgement, and zero/ambiguous rendezvous without heuristic suppression. TypeScript root and deep
LangGraph bundles share one versioned private process runtime, preventing cross-entrypoint tenant or
ownership drift.

The prior pre-hardening built TypeScript SDK and wheel-installed Python SDK each ran a real compiled
StateGraph through the real authenticated HTTP routes and PostgreSQL ledger. Each graph committed one
LLM (`$0.0005`) and one priced tool (`$0.10`), then refused the next paid node before its
provider/tool closure ran. The test proved exact operation/reservation/decision/rule/trace/step identities, two
usage and outbox rows only, zero legacy `/events`, and pooled account closure at `$0.1005` with zero
reserved or unresolved balance. ClickHouse projection and invoice immutability are intentionally
proven by their separate Workstream 4 and 10 suites rather than attributed to this one test. This
historical journey required a rerun from the final canonical TypeScript package and fresh Python
wheel; the completed final evidence follows.

A later exact-artifact rerun passed 1/1 with both packaged SDK journeys in the same service test. The
TypeScript runner resolved the official OpenAI peer from the attested outside-workspace install; the
Python runner proved OpenAI 2.45.0 and Pylva were loaded from the clean wheel environment. Both used
official request/response parsers with deterministic provider interception, and the TypeScript runner
captured operation/reservation identity from the real authoritative reservation exchange rather than
an expired asynchronous attempt context. That run used the now-superseded TypeScript SHA recorded in
D089 and the now-superseded Python wheel recorded above, so it is strong historical regression
evidence but is not the final record.

The final immutable LangGraph group passes 4/4 across three files. Its exact-artifact service path
uses TypeScript tarball SHA-256 `776c4e7683adbb7f276e837507c38728e2365e1dac228f11f02addd674edabf3`
and Python wheel SHA-256 `f26aeacad94aa073c42c764968cb7b4d3361fb99f622e4cf20882fe36ff8d74d`.
The Python environment passes `pip check` with Python 3.12, LangGraph 1.2.9, LangChain 1.3.13, OpenAI
2.45.0, and respx 0.23.1. The group retains the official-provider identity, exact
operation/reservation correlation, StateGraph allow/commit/refuse behavior, and zero duplicate
legacy billing required above. This completes local Workstream 9; the frozen-commit remote CI run
and its GitHub URL remain external pending evidence.

## Workstream 10 evidence — dashboard and customer-visible refusal

The Budget Activity API/read model/page distinguishes reserved, charged, released, unresolved, and
refused operations; rule, trace, and end-user views expose matching authority without counting
refusals as spend. Adaptive telemetry formatting never renders a nonzero sub-cent cost as zero, while
invoice currency remains two-decimal. Cost Sources is not yet production-correct: its page reads
authority tables through the denied general `withRLS` connection and remains release-blocking.

The real fixture uses production reservation, lifecycle, pricing, outbox, and projection services:
two allowed calls are charged and projected once; subsequent LLM and blocked-only tool calls are
refused before their fake provider counters move; authority, usage, outbox, actual cost, and invoice
state remain unchanged by refusal. Authenticated Chromium desktop and WebKit mobile journeys cover
matching filters/identities, a blocked-only trace and end user, accessible non-color status, and
horizontal-overflow protection. Budget Activity and account-state reads use the dedicated
tenant-scoped budget transaction rather than the ordinary general pool. A real credential-boundary
test proves the general login receives `42501` on authority tables while those dedicated read models
succeed. The Cost Sources owner-backed tests and browser coverage did not exercise that production
credential topology. Route/read-model/component suites and the production Next.js build pass, and
the final post-migration-054 desktop/mobile journey passes 5/5, but they do not close the Cost Sources
defect. The consolidated historical counts follow.

The coherent final dashboard run passes 43/43 exact unit/read-model tests, 6/6 focused component
tests, 65/65 broader dashboard tests across 17 files, 129/129 frontend tests across 22 files, and
21/21 API-key tests. Typecheck, lint, targeted formatting, and diff checks are green. The production
Next.js build emits 62 pages; route performance gates all pass. The dashboard client is 664,742 of
665,600 bytes (858 bytes headroom, 1,955 bytes smaller than its prior candidate), while the API-key
client is 665,511 of 665,600 bytes (89 bytes headroom). These remain hard gates, not automatically
expandable baselines.

The authenticated browser lane passes 5/5 across setup, desktop Chromium, and mobile WebKit. Its real
PostgreSQL/ClickHouse/Redis seed commits two controlled charges, records one refusal with zero denied
provider calls, and verifies exactly two projections. ClickHouse ends ready with zero mutations,
Redis returns `PONG`, and the local Next.js server on port 3000 is stopped. This local lane used Node
24, PostgreSQL 17.7, ClickHouse 26.5, and Redis 8.8; the older supported version matrix remains owned
by CI.

## Workstream 11 evidence — concurrency, chaos, and compatibility

Eleven real-service chaos gates exercised backend restart, response loss and idempotent replay, Redis
failure, ClickHouse outage/recovery, process death before/after dispatch, terminal races, overlap,
tenant isolation, period rollover, and new-SDK/old-backend plus old-SDK/new-backend behavior. Clean
built TypeScript and wheel-installed Python child processes contend against the same pooled `$1`
budget: exactly ten `$0.10` operations are authorized and ninety are refused, with no
over-authorization or source-tree Python import. The latest 11/11 pass consumed the exact pre-fix
TypeScript tarball and installed pre-fix Python wheel, both of which are now superseded. The final
immutable rerun now also passes 11/11 using TypeScript tarball SHA-256
`776c4e7683adbb7f276e837507c38728e2365e1dac228f11f02addd674edabf3` and Python wheel SHA-256
`f26aeacad94aa073c42c764968cb7b4d3361fb99f622e4cf20882fe36ff8d74d`. It preserves the exact
capacity, outage/recovery, process-death, terminal-race, overlap, tenant-isolation, period-rollover,
and old/new compatibility assertions without a source-tree Python import or rebuilt SDK candidate.
The separate backend concurrency/lifecycle/load lane is already in the 657/657 final service record.
This completes local Workstream 11; the corresponding frozen-commit remote CI run remains pending.

## Workstream 12 evidence — source release groundwork

Both package metadata/runtime versions identify 1.2.0 candidates. The pre-fix TypeScript and Python
hashes above proved the intended license/type/export/manifests and clean-install harnesses, but both
sets are superseded and cannot establish final artifact readiness. The focused
workflow covers shared contracts, Node/Python matrices, Pydantic
floor, PostgreSQL 16/17, ClickHouse 24.8/26.5, concurrency/chaos, clean-artifact LangGraph, projection,
and authenticated desktop/mobile dashboard gates, with a required aggregate label gate before merge.
The post-fix TypeScript tarball, Python wheel/sdist, stable hashes, four Python installed-package
profiles, 11/11 chaos group, and 4/4 LangGraph group now establish final local paired-artifact and
service readiness.
Generic `ci-integration` retains the ordinary service suite and delegates the cross-runtime chaos
and authoritative LangGraph tests to the focused workflow. TypeScript consumers reuse one hashed
tarball. The Python chaos and LangGraph service jobs currently build wheels independently, so they do
not yet prove one immutable Python artifact DAG across package and service gates. The static topology
contracts pass 15/15 for the structure they assert, but the 2026-07-17 review supersedes their
artifact-identity conclusion.

The final local repository-quality lane is green: dual SDK/root typechecks, full lint, Ruff, strict
Mypy across 47 Python files, changed/new formatting lanes covering 352 plus 50 files, seven workflow
YAML checks, conflict-marker and diff checks, 67/67 package/static checks, and 15/15 topology checks
all pass. Two unrelated baselines remain recorded for separate cleanup: global Prettier reports 56
untouched legacy files, and the unchanged issue-template YAML is invalid at line 45. Neither is
attributed to the authoritative-control diff.

The rollout guide, operations runbook, LangGraph ownership guide, candidate release notes, and release
checklist document strict scope, credentials, worker bounds, rollback, compatibility, and the future-
major default boundary. No package, tag, deploy, or feature activation was performed. At this
2026-07-15 review point, stable release was blocked on a frozen `main` candidate and recorded GitHub
URLs, and deployment was blocked on the production scheduler rehearsal, full shadow comparison,
internal canary, and owner approval. The 2026-07-17 reconciliation above adds source, test, CI, and
operations blockers that must close before those external gates.

## Historical implementation validation ledger — 2026-07-15 local record

This section preserves the produced local record from the 2026-07-15 tree. It is historical test
evidence, not the current release-readiness status; the 2026-07-17 independent QA reconciliation
above supersedes its unqualified `Pass` labels. The serialized backend,
database, concurrency, load, projection, billing, both immutable SDK artifacts, clean-artifact
services, dashboard, and repository-quality runs are recorded below. Remote CI matrix URLs, a frozen
merged commit, publication, production rollout, and activation are external pending evidence and are
not implied by a local `Pass`. Historical migration-050 and migration-053 counts above are not
substituted for migration-054 evidence.

| Validation area                  | Status | Recorded evidence or remaining requirement                                                                                                                                                                                                                                  |
| -------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migration integrity              | Pass   | 12/12 migration-runner gates; 50-entry head 054 with zero pending; fresh/replay/raw-054, DDL replay, manifest, text/JSON physical contract, and runtime-security checks pass; frozen hashes are below                                                                       |
| PostgreSQL role boundaries       | Pass   | 12/12 runtime-role migration, 4/4 general boundary, 17/17 general provisioner, and 3/3 budget provisioner; ordinary app, budget runtime, and migrator remain distinct and final cleanup is empty                                                                            |
| Backend and real-service control | Pass   | 657/657 serialized checks on PostgreSQL 17.7, ClickHouse 26.5.3.52 in `Asia/Riyadh`, and Redis 8.8; authority, concurrency/load, projection, billing, canonical reads, cron, readiness, and cleanup pass                                                                    |
| TypeScript SDK                   | Pass   | Post-fix 922/922 plus focused 73/73 and type/lint/format; one tarball `776c4e…abf3` passes topology/maps, optional-free, floor/current, AI refusal, ESM/CJS/mixed lifecycle, identity, and all fixed size gates                                                             |
| Python SDK                       | Pass   | Final source passes 148/148 focused and 702 passed plus 1 skipped full; Ruff+format, strict Mypy across 47 files, archive inspection, stable wheel `f26aea…d74d`/sdist `8574d8…0175` hashes, and all four floor/current profiles pass                                       |
| Clean-artifact service journeys  | Pass   | Final immutable TypeScript tarball and Python wheel pass two-SDK chaos 11/11 and LangGraph 4/4 across three files; exact-wheel Python 3.12 environment passes `pip check`                                                                                                   |
| Dashboard and browser proof      | Pass   | Unit/read-model 43/43, components 6/6, dashboard 65/65, frontend 129/129, API key 21/21, Playwright 5/5, type/lint/format/build/perf, real seed/projection, bundles, and cleanup pass                                                                                       |
| Repository hygiene               | Pass   | Dual SDK/root typecheck, full lint, Ruff, strict Mypy 47, changed/new format 352+50, workflow YAML 7, conflict/diff, package/static 67/67, and topology 15/15 pass; 56 untouched global-Prettier files and unchanged issue-template YAML line 45 remain unrelated baselines |

### Recorded backend and database service evidence — 2026-07-15

The final backend/service gate ran serially and made no source edits. Its 657/657 checks break down
as follows:

| Gate                                                 |  Result |
| ---------------------------------------------------- | ------: |
| Migration runner                                     |   12/12 |
| Authoritative runtime-role migration                 |   12/12 |
| PostgreSQL authority                                 | 230/230 |
| General-app runtime boundary                         |     4/4 |
| General-app provisioner                              |   17/17 |
| Budget-runtime provisioner                           |     3/3 |
| Reservation concurrency, lifecycle races, and load   |   29/29 |
| Real PostgreSQL/ClickHouse projection                |   26/26 |
| Projection, billing, canonical-read, and cron suites | 324/324 |

The migration and infrastructure commands included:

```bash
pnpm exec vitest run --config vitest.integration.config.ts \
  tests/integration/migration-runner.test.ts \
  --no-file-parallelism --maxWorkers=1
pnpm exec vitest run --config vitest.integration.config.ts \
  tests/integration/authoritative-budget-control-runtime-roles-migration.test.ts \
  --no-file-parallelism --maxWorkers=1
pnpm db:setup
pnpm exec tsx scripts/ci/provision-general-app-runtime.ts
pnpm exec tsx scripts/ci/provision-authoritative-budget-runtime.ts
pnpm db:migrate:verify-physical -- --contract authoritative_budget_ledger
pnpm exec tsx tests/fixtures/authoritative-budget-runtime-posture-runner.ts
pnpm clickhouse:doctor
```

The authority, provisioner, concurrency, projection, and billing invocations used the exact file
lists wired into `authoritative-budget-control-ci.yml`, with file parallelism disabled and one worker.

`db:setup` reported PostgreSQL manifest head 054 with zero pending migrations and replayed the
ClickHouse DDL successfully. Both runtime provisioners, the physical contract verifier
(`in_sync` and `runtime_security`), production-posture checks, ClickHouse doctor, and Redis `PONG`
passed. The reused PostgreSQL cluster initially contained the main-database `CONNECT` grant that CI
adds later in its ordered workflow; the gate temporarily removed it to prove the exact CI posture and
then restored the same grant. ClickHouse initially lacked the historical model-aggregate trust
marker, so ingest was stopped and the repository's official `clickhouse:backfill-model-daily`
procedure restored it before doctor ran. Neither finding required a source edit. The final state had
no leaked scratch databases or temporary roles and ClickHouse reported zero pending mutations.

The immutable database files remained byte-identical:

| Database file                                                   | SHA-256                                                            |
| --------------------------------------------------------------- | ------------------------------------------------------------------ |
| PostgreSQL `050_authoritative_budget_control_ledger.sql`        | `3bd8b69ef1b09814e6cc0645b2eb188504fc84b4e15abbe5e42ddf704619218e` |
| PostgreSQL `051_authoritative_budget_control_runtime.sql`       | `3fabbc1236e562eddd1b83e4c8826abfb61d0eca73b8e4773b10d94599055af8` |
| PostgreSQL `052_authoritative_budget_control_runtime_roles.sql` | `3cc7efe258ceb49e9fd56789c3fdb9a0f6cd76e990d5f5681ecc24cde4172be6` |
| PostgreSQL `053_legacy_catalog_owner_rls_compatibility.sql`     | `ba598fab2d79316926ebce3e853c61a1408dae14cd4bb40a0a572f0a90bb431f` |
| PostgreSQL `054_general_app_runtime_owner_boundary.sql`         | `f6e3be6b0a190f00a2f620fdacbacbb34cdbfcc522a9d138a59e1142b7cd8dbb` |
| ClickHouse `001_cost_events.sql`                                | `10c202980be50d301aa357a21b6c78c26da68278ae88de18efdac212d3cb68f8` |
| ClickHouse `011_authoritative_budget_projection.sql`            | `b900b99915320fff8e0e671c5d03b0f05103b86bc4cb41a0fac8cd832876e443` |
| ClickHouse `012_cost_events_utc_timestamp.sql`                  | `36d50c4180c985c60d011425b5740942be94ef553e9b3b76f842ae171117e3ca` |

Candidate GitHub job URLs, a frozen merged `main` SHA, production credential attestation, scheduler
rehearsal, the full shadow period, internal canary, demo-environment operations proof, release-owner
approval, tags, deployment, and registry publication remain external pending gates. No local entry
in this ledger can satisfy or imply any of them.

## 1. Shared contract

Add one language-neutral budget-control contract and a canonical JSON fixture corpus consumed by the backend and both SDKs.

Common reservation fields:

```text
schema_version
mode
operation_id
customer_id
trace_id
span_id
parent_span_id
step_name
framework
reservation_ttl_seconds
```

LLM intent reports provider, model, conservative estimated input tokens, and maximum output tokens. Tool intent reports `cost_source_slug`, tool name, metric, and a canonical-decimal maximum metric value. Clients never submit authoritative dollars. One logical operation ID is stable across transport retries; a separately identified provider attempt receives its own reservation when routing or failover changes the priceable action.

Responses are discriminated as `reserved`, `denied`, `bypassed`, or `unavailable`. Expected allow/refuse decisions return HTTP 200; invalid requests use 400, authentication failures 401/403, tenant-safe missing resources 404, lifecycle/idempotency conflicts 409, throttling 429, and genuine service failures 5xx.

All monetary wire values and potentially fractional tool quantities are canonical decimal strings.
Request schemas reject unknown properties; response schemas tolerate additive known-safe properties
but reject unknown discriminator variants and contradictory states. Control requests structurally
allow only documented identity and usage fields and reject content-bearing fields such as prompts,
messages, URLs, tool arguments/results, credentials, and raw provider errors. This is field-level
allowlisting, not secret-content detection inside an otherwise allowed identifier. Runtime logs must
not emit raw exception messages; release remains blocked until every public route and dashboard read
uses sanitized error codes or classes instead.

Budget authorization uses server time and allows an action when:

```text
committed + reserved + unresolved + requested <= limit
```

Any applicable hard-stop rule denying the request makes the entire reservation fail without partial holds. Advisory rules return warnings but never block.

## 2. Authoritative backend ledger

Add PostgreSQL tables for:

- Budget accounts keyed by builder, immutable rule key/snapshot, scope subject, and period.
- Immutable global rule revisions that change limit/enforcement for every account without resetting spend.
- Reservations keyed idempotently by builder and operation ID.
- Reservation allocations connecting one action to every applicable pooled/per-customer account.
- Append-only reservation lifecycle transitions proving extensions, expiry, commit, and release.
- A short-retention authoritative usage ledger.
- A durable cost-event outbox for ClickHouse projection.

The physical PostgreSQL authority is a closed nine-table surface:

| Migration                                      | Tenant-owned authoritative relations                                                                                                                                                         |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `050_authoritative_budget_control_ledger.sql`  | `budget_accounts`, `budget_rule_revisions`, `budget_reservations`, `budget_reservation_allocations`, `budget_reservation_transitions`, `budget_usage_ledger`, and `budget_cost_event_outbox` |
| `051_authoritative_budget_control_runtime.sql` | `budget_control_cutovers` and `budget_account_opening_evidence`, plus the shared non-cycling `pylva_budget_authority_order_seq`                                                              |

All nine tables have RLS enabled and forced. Migration 052 adds sealed runtime/discovery roles,
bounded projection and expiry discovery functions, and exact ACLs without adding another authority
table. Migration 053 changes only the owner-bypass posture of four named legacy catalogs. Migration
054 adds the temporary general-app owner boundary and bounded audit-partition function but grants the
general application no access to these nine tables or their sequence.

Persist requested, held, released, limit, opening, and unresolved amounts with `NUMERIC(38,18)`-compatible fixed decimal arithmetic. Use `NUMERIC(44,18)` for post-provider per-operation actual cost and overage, the exact maximum implied by the v1 tool quantity and price bounds. Keep the internal account `committed_usd` accumulator as unbounded PostgreSQL `NUMERIC` so accumulated real charges are never discarded because the running total exceeds either public representation. Workstream 3 returns an explicit unavailable result when a derived pre-dispatch value cannot be represented on the reservation wire. Preserve rule and pricing snapshots so deletion or price changes cannot rewrite historical decisions. Apply RLS to all tenant-owned tables.

The reserve transaction authenticates the builder from the API key, validates and hashes the request, resolves fresh pricing/rules, locks account rows in deterministic order, evaluates every rule, and either persists one refusal or all required allocations atomically.

Commit replaces held capacity with actual server-priced usage, releases the difference, records overage rather than hiding it, and creates the authoritative usage-ledger/outbox records exactly once. The controlled commit path is the sole owner of billable telemetry for that operation; it suppresses a duplicate legacy `/events` write. Release is allowed only when the provider was definitely not charged. Ambiguous expiry moves capacity to `unresolved`; it is not silently released or billed as actual spend. Long-running operations can extend their lease.

Redis and SDK-local memory are not sources of authority. ClickHouse outages must not roll back or weaken a committed control decision.

Outbox projection into ClickHouse is idempotent and continuously reconciled, but Pylva must not claim exactly-once ClickHouse analytics until lost-ack behavior has been proven against the deployed ClickHouse version and every dependent materialized view. Control and billing correctness read PostgreSQL authority, or billing is explicitly gated on a verified projection watermark and a drained outbox for the billed period.

ClickHouse migration `011_authoritative_budget_projection.sql` defines three distinct surfaces.
`budget_cost_events` is the projector-only physical table and reconciliation target.
`budget_cost_events_final` groups retries by builder, timestamp, and event identity and exposes
`payload_hash_count`; authoritative consumers admit only rows with exactly one payload hash.
`cost_events_with_control` is the telemetry/analytics union of legacy and deduplicated controlled
events and applies telemetry retention. After PostgreSQL billing closure passes, billing reads
legacy `cost_events` and conflict-free `budget_cost_events_final` rows in separate branches so
controlled `Decimal(44,18)` facts never cross the legacy `Float64` union boundary. Migration 012
changes only the legacy timestamp annotation to `DateTime('UTC')`; it does not rewrite stored epochs.

## 3. Backend APIs

Add SDK-key endpoints:

```text
GET  /api/v1/budget/capabilities
POST /api/v1/budget/reservations
POST /api/v1/budget/reservations/{id}/commit
POST /api/v1/budget/reservations/{id}/release
POST /api/v1/budget/reservations/{id}/extend
```

Reserve, commit, release, and extend bodies are strict UTF-8 JSON capped at 16,384 bytes, including
chunked requests and requests with absent or dishonest `Content-Length`. Malformed UTF-8, invalid
JSON, and oversized bodies return non-cacheable validation errors before a service call.
Capabilities advertises `schema_version`, `control_enabled`, server time, and reservation TTL bounds
of 30 seconds minimum, 300 seconds default, and 3,600 seconds maximum. Every SDK-key response is
non-cacheable.

Budget Activity is a separate dashboard-session endpoint, not an SDK-key lifecycle endpoint:

```text
GET /api/v1/budget-activity
```

Its builder identity comes only from the authenticated dashboard session and current organization
membership. It accepts status/kind filters, customer, source, trace, rule, and bounded pagination.
The response contains PostgreSQL-authoritative activity and allocation proof with
`authority: "postgresql"` and `Cache-Control: private, no-store, max-age=0`.

Identical operation retries return the stored decision. Reusing an operation ID with a different canonical request returns 409. Commit/release/extend transitions are idempotent, and conflicting terminal transitions never refund or double-charge.

The backend owns pricing. Unknown/unpriced bounded operations return an explicit control-unavailable decision in enforce mode. Shadow mode records the would-allow/would-deny result without blocking.

## 4. SDK public API parity

Keep existing `init()` and legacy reporting signatures backward compatible. Add:

| TypeScript       | Python async            | Python sync            |
| ---------------- | ----------------------- | ---------------------- |
| `ready()`        | `await ready()`         | `ready_sync()`         |
| `reserveUsage()` | `await reserve_usage()` | `reserve_usage_sync()` |
| `commitUsage()`  | `await commit_usage()`  | `commit_usage_sync()`  |
| `releaseUsage()` | `await release_usage()` | `release_usage_sync()` |
| `extendUsage()`  | `await extend_usage()`  | `extend_usage_sync()`  |

Python synchronous calls use a real synchronous HTTP client rather than `asyncio.run()`.

Configuration is additive:

```text
control.mode = legacy | shadow | enforce
control.onUnavailable = allow | deny
```

SDK 1.x defaults remain `legacy` and `allow`. The strict demonstration uses `enforce` and `deny`.

`ready()` verifies authentication and server capabilities, coalesces concurrent calls, uses a bounded timeout, and invalidates builder-scoped caches when endpoint/key configuration changes. Add a distinct control-unavailable error while preserving every existing `PylvaBudgetExceeded` field and catch path.

The wire stays snake_case. TypeScript exposes its established camelCase facade and maps once at the transport boundary; Python exposes snake_case. All backend responses are runtime-validated before mutating SDK state. Reject booleans, negative values, NaN, infinity, malformed IDs, invalid states, and unsafe monetary values consistently in both languages.

## 5. LLM enforcement

Provider wrappers execute in this order:

1. Resolve customer and graph context.
2. Accept the caller-selected provider/model as the final strict-attempt identity.
3. If the caller routes or falls back, begin a separate wrapped attempt with a fresh operation identity.
4. Calculate a conservative bounded usage estimate locally without transmitting content.
5. Reserve immediately before dispatch.
6. Invoke the provider.
7. Commit actual tokens or retain unresolved capacity when dispatch occurred but usage is unknown.
8. Release only when the provider was definitely not charged.

SDK 1.2 guarantees this sequence through explicit controlled integrations (`wrapOpenAI` / `wrapAnthropic` in TypeScript and `wrap_openai` / `wrap_anthropic` in Python). Existing automatic monkey patches and their model-routing/failover engine remain backward-compatible legacy telemetry only and are not advertised as fail-closed enforcement. The strict API does not route or fail over implicitly. Provider-native retries are disabled; a caller-selected retry or fallback must enter a separately wrapped call and receive its own reservation for the actual provider/model.

The first strict, price-complete subset is OpenAI Chat Completions and Anthropic Messages with text plus client-side function/tool schemas, one completion, standard service tier, an explicit maximum-output bound, and no separately priced cache, audio, remote-media, hosted/server-tool, batch, priority, or long-context component. Strict mode refuses unsupported paid features before dispatch. If an unexpected paid component appears only after a dispatched response, settlement remains unresolved rather than committing an inaccurate zero/base-only cost. Expanding this subset requires an additive wire/pricing/ledger change in both SDKs and the backend; a wrapper-only approximation is not sufficient.

Strict mode requires a maximum-output bound. Each routed, fallback, or failover attempt gets independently correct authorization because pricing may differ. Streaming reservations remain unsettled until completion, explicit close, abort, cancellation, consumer error, or lease expiry.

Cover Python OpenAI sync/async, Python Anthropic sync/async, TypeScript OpenAI, TypeScript Anthropic, and supported Vercel AI paths. Preserve Vercel `streamText()`'s synchronous return contract; strict control uses an explicit async controlled helper if transparent awaiting would be breaking.

## 6. Non-LLM enforcement

Keep `reportUsage()` and `report_usage()` as post-call tracking-only APIs. Add explicit controlled helpers for:

- Exact usage, such as one search credit.
- Bounded variable usage, such as up to ten pages with six actually consumed.
- Unknown/unpriced usage, which strict mode refuses and shadow/legacy mode reports through an
  explicit non-authoritative status without claiming that the operation was controlled.

The first official adapter is Tavily Search. The provider/tool function must not be invoked when reservation is denied. The backend prices a precise cost-source slug and metric; the SDK never invents or trusts a client-provided USD amount.

## 7. LangGraph ownership and deduplication

Provider wrappers own LLM enforcement and billable LLM telemetry. LangGraph callbacks own graph/node attribution and tool observation. Both share operation, reservation, trace, and span identifiers.

Add callback LLM tracking modes `auto`, `callback`, and `off`. `auto` suppresses callback LLM billing when an active wrapper-owned operation exists, while retaining node attribution. Callback-only tracking remains available. Guaranteed tool blocking uses the explicit controlled helper until real LangGraph error-propagation tests prove callback blocking safe.

Under `auto` mode and exactly one per-invocation control scope, one provider attempt creates one
reservation, one settlement, and one billable event even when root/deep entrypoints and wrappers are
combined. `callback` mode intentionally remains callback-owned, and zero-match or ambiguous
multi-callback scopes warn and leave callback telemetry unsuppressed rather than guessing.

## 8. Dashboard and precision

Add a Budget Activity read model/page for reserved, charged, released, unresolved, and refused actions. A refusal shows customer, source, step, trace, rule/period, committed/reserved/unresolved amounts, requested maximum, remaining balance, reason, and `provider request: not sent`.

Extend rule, end-user, and trace views with applicable budget state and recent control actions. Blocked-only customers/traces must render. A committed reservation decorates its matching cost span rather than creating a duplicate row.

Blocked/reserved actions do not enter cost events, usage event counts, invoice totals, or spend aggregates. Cost Sources explicitly distinguish `Protected`, `Ready to protect`, `Tracking only`, and `Unpriced/uncontrolled`.

Protection labels are derived in fail-closed order:

- `Unpriced/uncontrolled` when a source is not tracked, has broken health, or lacks pricing.
- `Tracking only` when it is otherwise priceable but authoritative control, runtime posture, or the
  workspace cutover is not ready.
- `Ready to protect` when the control path is ready but no active hard-stop budget exists.
- `Protected` only when the control path is ready and at least one active hard-stop budget can gate
  the priced source. Actual coverage still follows that rule's scope and customer targeting.

Use a dedicated adaptive telemetry-cost formatter: zero remains `$0.00`; nonzero sub-cent values display enough precision and never appear as zero. Invoice currency remains two-decimal formatting.

Canonical monetary strings go directly to `formatTelemetryUsd` and must not cross JavaScript
`Number`. `formatLiveTelemetryUsd` is reserved for live counters that have already crossed the
JSON-number boundary. Invoice and billing currency continues to use `formatUsd`.

## 9. Test matrix

### Shared contract

- One golden fixture corpus verifies all decisions, lifecycle states, errors, decimal encoding, defaults, and malformed responses in backend, TS, and Python.
- Privacy fixtures assert that content/tool payload fields cannot appear.

### Backend unit and route tests

- LLM input/output pricing; flat/tiered tool pricing; custom-pricing precedence.
- Unknown, ignored, pending, zero-priced, and unpriced sources.
- Fixed-decimal rounding and exact-limit behavior.
- Customer, global per-customer, pooled, targeted, overlapping, advisory, disabled, and draft rules.
- Hour/day/week/month and leap-date boundaries using server time.
- Reserve/commit/release/extend/expiry/late-commit state transitions.
- Actual usage below, equal to, and above reservation.
- Rule/pricing changes or deletion during an operation.
- Duplicate and conflicting idempotency keys.
- Authentication, RLS, tenant-safe 404, rate limiting, and metadata allowlisting.

### SDK unit and wrapper tests

- Readiness coalescing, timeout, cache invalidation, and old-backend capability fallback.
- Fail-open versus explicit fail-closed behavior.
- Runtime validation of every success/error response.
- Denial proves provider/tool invocation count is zero.
- Success creates one reservation and one settlement.
- Pre-dispatch failure releases; post-dispatch ambiguity does not.
- Streaming completion, early close, abort, cancellation, consumer exception, and missing usage.
- Routing/fallback/failover pricing and settlement.
- Legacy `reportUsage` behavior remains unchanged.
- Python sync/async parity and TypeScript ESM/CJS built-artifact parity.
- Wrapper plus callback emits one billable event while preserving graph attribution.

### Real-service integration, concurrency, and chaos

- A $1 budget with 100 simultaneous $0.10 reservations allows exactly ten.
- Python and TypeScript processes contend against the same pooled budget.
- Per-customer accounts remain isolated; overlapping rules reserve all-or-nothing.
- High-cardinality hourly and per-customer first-use account materialization meets an explicit latency and builder-lock-wait budget before enforcement rollout.
- Duplicate reserve races create one operation; commit/release races have one winner.
- Backend restart preserves state.
- Redis failure cannot weaken control.
- ClickHouse failure preserves the authoritative ledger and later outbox recovery projects one event.
- Lost HTTP response followed by an idempotent retry.
- Process death after reserve and after provider dispatch.
- Period rollover with active reservations.
- Legacy and controlled traffic reconcile without double-counting.
- Old SDK/new backend and new SDK/old backend compatibility.

### Full LangGraph and dashboard E2E

- Python and TS graphs each allow and commit one LLM plus one tool, then refuse the next paid node.
- Exactly two cost events and one refusal are visible with matching customer/step/trace/rule IDs.
- Refusal does not change spend, event counts, or invoices.
- Blocked-only traces render, filters are accessible, status is not color-only, and mobile layouts remain usable.

## 10. CI, rollout, and release gates

Run Python 3.10–3.13; Node 20.18.1, 22, and 24; TS ESM/CJS; Python wheel/sdist; npm artifact/size checks; shared contract parity; real-service integration; concurrency; LangGraph journeys; dashboard E2E; migration-manifest and physical-schema verification.

Release is blocked unless every refusal invokes the provider/tool zero times, concurrent reservations never over-authorize, authoritative usage and refusals are recorded exactly once, analytics projection reconciles without duplicate contributions, refusals never enter billing, tenant isolation holds, private payloads never leave the SDK, and both SDKs return equivalent decisions.

Roll out behind `ENABLE_AUTHORITATIVE_BUDGET_CONTROL`: backend/schema first, shadow comparison, SDK prereleases, current-period reconciliation, internal canary, strict demo workspace, chaos/load gates, then stable opt-in SDK 1.2.0 releases. Make enforcement the default only in a future major SDK release after adoption evidence.

## Completion rule

No workstream becomes `Complete` on partial implementation, passing unit tests alone, or an unverified claim. Completion requires all evidence listed in the progress ledger plus applicable cross-language, integration, packaging, migration, privacy, and dashboard checks. Record major deviations and decisions in `docs/authoritative-all-cost-control-decisions.md`.
