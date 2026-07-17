# Authoritative Budget Control: Release Readiness

> Target: opt-in TypeScript and Python SDK 1.2.0 releases. This is a checklist, not a record that the
> release is approved. Never publish, tag, deploy, or enable enforcement merely because this file is
> complete in source control.

Use this checklist with the
[HTTP contract](./authoritative-budget-control-rollout.md#machine-http-contract),
[SDK architecture](./authoritative-budget-control-rollout.md#sdk-architecture-and-controlled-attempt-lifecycle),
[upgrade and rollout guide](./authoritative-budget-control-rollout.md) and the
[operations runbook](./authoritative-budget-control-operations.md). The
[SDK 1.2.0 candidate release notes](./sdk-1.2-authoritative-control-release-notes.md) summarize the
public surface and supported price-complete subset without implying publication.

## Current source truth

| Artifact     | Metadata now                            | Runtime version now                          | 1.2.0 status                                           |
| ------------ | --------------------------------------- | -------------------------------------------- | ------------------------------------------------------ |
| `@pylva/sdk` | `packages/sdk-ts/package.json`: 1.2.0   | `packages/sdk-ts/src/core/version.ts`: 1.2.0 | Candidate metadata aligned; not published by this work |
| `pylva-sdk`  | `packages/sdk-py/pyproject.toml`: 1.2.0 | `packages/sdk-py/pylva/_version.py`: 1.2.0   | Candidate metadata aligned; not published by this work |

Both source packages now identify as 1.2.0, but the paired release remains blocked until every gate
below has recorded evidence. This groundwork does not publish either artifact.

Current local immutable evidence is paired. The final TypeScript tarball is frozen at SHA-256
`776c4e7683adbb7f276e837507c38728e2365e1dac228f11f02addd674edabf3`; that exact byte sequence
passes topology/source-map, optional-peer-free, floor/current, AI-version refusal, official
ESM/CJS/mixed lifecycle, identity, and fixed-size gates. The latest complete local Python source run
passes 705/705, with package/test Ruff and strict Mypy across 47 files. The final wheel SHA-256 is
`f26aeacad94aa073c42c764968cb7b4d3361fb99f622e4cf20882fe36ff8d74d`; the sdist SHA-256 is
`8574d814089a243787e9ef751eaee8e39be7305f46db5eaf5daedb563eb20175`. Archive inspection and all
four wheel/sdist-by-provider-floor/current installed profiles pass with stable hashes.

The exact Python wheel environment passes `pip check` under Python 3.12 with LangGraph 1.2.9,
LangChain 1.3.13, OpenAI 2.45.0, and respx 0.23.1. Together, the immutable TypeScript tarball and
Python wheel pass the final two-SDK chaos group 11/11 and LangGraph group 4/4 across three files.
None of these local passes is a frozen merged commit, GitHub-run URL, registry publication,
deployment, production shadow/canary, scheduler rehearsal, or stable-release record.

## Independent QA blockers — 2026-07-17

The independent audit reran the core source, build, package, database, concurrency, projection,
chaos, and LangGraph suites successfully. Those results prove that the central
reserve/refuse/settle design works locally, but they do not make this source candidate release-ready.
Close every item below before recording candidate CI:

- [ ] Move Cost Sources authority reads out of general `withRLS` and prove the page through an
      ordinary general-app login that is denied direct authority-table access.
- [ ] Sanitize the capabilities missing-header response and replace raw Budget Activity exception
      messages in API/RSC logs with allowlisted codes or classes; assert response and logger output.
- [ ] Replace date-only ClickHouse reconciliation casts with explicit UTC instants and enforce one
      end-to-end five-second posture-attestation lifetime.
- [ ] Make malformed, including unhashable, Python control configuration raise only the documented
      validation error.
- [ ] Build one hash-addressed Python wheel/sdist pair in focused CI and reuse that exact wheel in
      package, chaos, and LangGraph jobs; require the expected SHA in every runner.
- [ ] Reject every unexpected network origin in clean-artifact service runners.
- [ ] Add release regressions for real Redis throttling, expiry-created unresolved dashboard
      activity, direct/async Tavily denial, span/parent-span service identity, and streaming
      wrapper-plus-callback deduplication.
- [ ] Run `tests/security/middleware-budget-control-auth.test.ts` in a required workflow.
- [ ] Make both publish workflows attest focused, fast/security, integration, and ordinary E2E
      success for the exact release SHA.
- [ ] Add byte equality for both packaged SDK READMEs and an explicit non-`latest` npm dist-tag
      procedure for prereleases.
- [ ] Provide and rehearse the audited readiness operator command; the public repository currently
      exposes only internal readiness services.

The detailed durable lessons are D100–D114 in the decision log. The recorded 2026-07-15 pass counts
remain valid evidence for the paths they exercised, but they do not override this blocker list.

## CI surface added for the candidate

`.github/workflows/authoritative-budget-control-ci.yml` defines these gates:

- shared backend, TypeScript, and Python wire-contract replay;
- TypeScript on Node 20.18.1, 22, and 24;
- npm tarball inspection plus clean ESM, CJS, and CLI execution;
- Python on 3.10, 3.11, 3.12, and 3.13;
- wheel and sdist inspection plus isolated installation of each format;
- PostgreSQL schema, RLS, pricing, reservation, readiness, and exact-backfill integration;
- transaction, race, rollback, expiry, and high-cardinality first-use gates;
- backend restart, lost-ack recovery, Redis outage, process-death, overlap, isolation, and period
  rollover chaos gates;
- child-process chaos that loads the TypeScript SDK from built `dist` and Python from a clean wheel
  installed into an isolated environment, with no source `PYTHONPATH`;
- migration/runtime credential parser, shell, container-stage, raw-client-boundary, and production
  role-posture gates, including the separate migration/general-app/budget-runtime topology;
- dedicated ClickHouse reader/projector identity, RBAC-posture, projection, and recovery gates;
- LangGraph service journeys and SDK callback/non-LLM policy tests; and
- budget-activity route/read-model/component tests plus the authenticated desktop/mobile
  budget-activity browser journey.

Package and contract matrices run for matching pull-request paths. Full-service and browser jobs are
label-gated on pull requests because they start three real services, create many scratch databases,
and install browsers; delaying them keeps draft iteration responsive without weakening the release
bar. Add `authoritative-control-full` when the pull request is ready for final review. The final gate
fails until that label is present and every focused job succeeds, so the label is required before
merge and release. Main, scheduled, and manual runs execute the full jobs automatically.

A workflow definition is not evidence of a passing run: record the commit SHA and URLs for every
required green job below.

## Candidate preparation

- [ ] Freeze one candidate commit already merged to `main`.
- [ ] Confirm all 50 PostgreSQL migrations are synchronized, migration
      `054_general_app_runtime_owner_boundary.sql` is the manifest head, frozen 050–053 checksums
      have not drifted, and the final reviewed 054 checksum is recorded.
- [ ] Apply migrations using only `MIGRATION_DATABASE_URL`/`MIGRATION_DB_*`; prove the production
      migration task receives neither general nor budget-control credentials.
- [ ] On upgrade, apply migration 054 with the historical migration time zone that created the
      existing audit partition runway. Record its successful bound comparison; a mismatched bound or
      ownership-normalization precondition must fail closed rather than be bypassed with application
      privileges.
- [ ] Provision `DATABASE_URL` as a distinct ordinary general-application login through the
      provisioning-only `GENERAL_APP_DATABASE_URL`. Confirm its only outbound membership is
      `pylva_general_app_runtime` with INHERIT but no ADMIN or SET, and that the login is not the
      migration or budget-control principal.
- [ ] Provision a distinct budget-control login and secret before deploying the image. Confirm it
      inherits only the intended non-dangerous privileges through `pylva_budget_control_runtime`.
- [ ] Confirm ClickHouse migrations are applied through
      `012_cost_events_utc_timestamp.sql`, fresh schema 001 declares `cost_events.timestamp` as
      `DateTime('UTC')`, and the doctor rejects the historical bare `DateTime` posture. On upgrade,
      record that migration 012 preserves existing epochs and makes a new timezone-free ingest UTC.
- [ ] Provision a distinct `BUDGET_PROJECTION_CLICKHOUSE_URL` identity before deploying the image.
      Confirm the general identity cannot write `budget_cost_events`, while the projector can only
      insert/inspect that table and has no destructive, user-management, global, or unrelated-table
      privileges.
- [ ] Run `pnpm clickhouse:provision-budget-rbac` with three distinct credential-bearing HTTPS URLs
      against every deployment access-control scope. Record that its exact-role and writer-catalog
      audit passed, with only the projector role and explicit break-glass admin retained as writers.
- [ ] Confirm the shared contract corpus version and SDK schema constants are unchanged or have an
      explicitly reviewed compatibility plan.
- [ ] Set both public package metadata files and both runtime version sources to the intended
      candidate version.
- [ ] Update package metadata/version tests, SDK READMEs, changelog/release notes, and migration
      guidance in the same reviewed release change.
- [ ] Document the application/provider trust model: either every credential-bearing paid path is
      cooperative and uses a supported controlled integration, or adversarial code is isolated from
      reusable provider credentials and direct provider egress behind a trusted control-plane proxy.
- [ ] Confirm neither package manifest contains a private `@pylva/*` runtime dependency or
      `workspace:` range in a publishable dependency field.
- [ ] Confirm license, repository, exports, Python typing marker, and CLI files exist in the packed
      artifacts.
- [ ] Confirm the release commit contains no registry token and publishing still uses the existing
      GitHub OIDC/trusted-publishing workflows.

Derive candidate versions from metadata rather than typing them into release commands:

```bash
TS_VERSION="$(node -p "require('./packages/sdk-ts/package.json').version")"
PY_VERSION="$(python - <<'PY'
import pathlib
import tomllib

print(tomllib.loads(pathlib.Path('packages/sdk-py/pyproject.toml').read_text())['project']['version'])
PY
)"
test "$TS_VERSION" = "$PY_VERSION"
```

## Required automated evidence

- [ ] `Shared wire-contract parity` is green.
- [ ] All three TypeScript Node matrix legs are green.
- [ ] TypeScript unit tests, strict type tests, build, size limit, packed manifest, ESM, CJS, and CLI
      smoke checks are green.
- [ ] All four Python matrix legs are green.
- [ ] Python 3.10 passes contract, client, and ownership tests on the declared Pydantic 2.5.0 floor.
- [ ] Python tests, Ruff, Mypy, wheel inspection/install, and sdist inspection/install are green.
- [ ] One Python artifact-producing job builds the wheel and sdist exactly once, uploads both plus
      SHA-256 metadata, and every package, chaos, LangGraph, and release consumer downloads and
      verifies that same pair without rebuilding.
- [ ] Each Python artifact consumer verifies hashes before and after use, reports the installed
      `pylva` path/version, runs `pip check`, and rejects source-tree or ambient-package substitution.
- [ ] Python async provider gates prove first-operational-loop affinity, local `invalid_client` on
      wrong-loop use, owner-loop shutdown ordering, and exact-once raw stream shutdown scheduled
      before the first cancellation point on provider-stream failure.
- [ ] The migration artifact contains `db/migrations/` and `db/migration-phases.json`; the regenerated
      50-entry manifest is byte-identical to the checked-in module, identifies 054 as head, and marks
      only migration 048 as `post_roll`.
- [ ] A fresh PostgreSQL database, no-op replay, raw 054 replay, and restored-like ownership posture
      pass ledger status plus both `api_keys_scope` and `authoritative_budget_ledger` physical
      contracts.
- [ ] A live pre-048 rehearsal proves `pre_roll` stops before 048, `post_roll` applies the ordered
      suffix, the final sweep captures a late legacy writer, and rollback detects a post-048
      universal key with no historical backup before old code is deployed.
- [ ] General-app role attestation passes against the real `DATABASE_URL` login: LOGIN/INHERIT,
      NOSUPER/NOBYPASS/NOCREATEDB/NOCREATEROLE/NOREPLICATION, exactly one inherited fixed-owner
      outbound membership with no ADMIN/SET, only the non-inheriting/no-SET migrator creator-admin
      reverse edge, exact legacy ownership surface, and no direct ACL drift.
- [ ] The general login completes real pre-GUC OAuth/magic-link and API-key bootstrap paths plus
      tenant-scoped CRUD, but cannot read or mutate any authority table/sequence or assume the fixed
      owner role explicitly.
- [ ] Audit partition creation through `pylva_ensure_audit_log_partition(date)` preserves the
      captured historical migration-zone bounds, rejects a mismatched existing bound, and supports
      the intended retention/drop path without migration credentials in the application.
- [ ] Runtime role attestation passes against the real dedicated login: NOSUPER/NOBYPASS,
      NOCREATEDB/NOCREATEROLE/NOREPLICATION, `row_security=on`, no protected ownership or dangerous
      membership path, and EXECUTE on both bounded discovery functions.
- [ ] The same login cannot directly cross-tenant scan builders, reservations, or the outbox and
      cannot `SET ROLE` either discovery owner; projection and expiry succeed through their bounded
      functions.
- [ ] PostgreSQL authority and exact-backfill integration is green.
- [ ] Concurrency/chaos integration is green, including exact capacity under contention, terminal
      races, transaction rollback, expiry, and the first-use latency budget.
- [ ] Projection and RBAC integration is green against both the supported ClickHouse 24.8 floor and
      the current ClickHouse release, including actual denied inserts by a direct unrelated user and
      a user inheriting a broader writer role.
- [ ] Production projection posture rejects a missing/reused/over-privileged projector identity;
      local/CI URL reuse succeeds only with the explicit fallback flag; production HTTP or
      credential-free URLs fail closed; repaired failures retry immediately; successful role drift
      is detected within five seconds.
- [ ] The five-second test drives the default projection target end to end, primes inner posture and
      outer client caches at different fake-clock offsets, and measures from the last completed
      attestation.
- [ ] The ClickHouse UTC contract rejects implicit `Date`-to-timestamp comparisons; pricing
      reconciliation passes on a non-UTC server with exact UTC day boundaries.
- [ ] Every control mutation enforces the 16 KiB streaming limit, dishonest `Content-Length`, fatal
      UTF-8 decoding, closed schemas, and zero service invocation on invalid input.
- [ ] All five control routes return the same sanitized non-cacheable internal response when trusted
      middleware context is absent; complete bodies expose no trusted-header names or raw errors.
- [ ] Clean-artifact provider runners allow only configured local Pylva paths and an explicitly
      mocked canonical provider route; every other origin/path fails before network I/O.
- [ ] LangGraph service and callback jobs are green.
- [ ] Budget-activity route/read-model/component and authenticated desktop/mobile browser-journey
      jobs are green.
- [ ] The production-credential journey renders all five Budget Activity states, including an
      expiry-created `unresolved` action, and renders Cost Sources while direct general-login
      authority access receives SQLSTATE `42501`.
- [ ] Failure tests capture structured logger arguments and prove raw exception messages, connection
      strings, credentials, request bodies, and tenant-private payloads are absent.
- [ ] The release pull request carried `authoritative-control-full`, and the final aggregate gate is
      green before merge.
- [ ] Existing repository fast CI, security tests, full integration, and ordinary dashboard E2E are
      also green; this focused workflow does not replace them.
- [ ] Both publish workflows independently attest those exact-SHA required workflow runs instead of
      accepting the focused workflow alone.
- [ ] The npm tarball and Python sdist READMEs are byte-identical to their sources; wheel metadata
      contains the normalized Python README content.
- [ ] A prerelease TypeScript version publishes with an explicit non-`latest` dist-tag.

Attach the GitHub run URLs and candidate SHA to the release record. Do not replace a missing job with
a local claim.

## Locally passed core gates awaiting fixes and candidate CI records

The repository contains the local chaos, LangGraph, browser, and compatibility harness families.
The final local candidates pass chaos 11/11 and the LangGraph group 4/4 across three files, but the
focused workflow does not yet preserve one Python artifact identity across both service jobs and the
browser suite does not visit every authority-bearing page:

- clean wheel-installed Python and built TypeScript processes contend against one pooled budget in
  `authoritative-budget-chaos.test.ts` without over-authorization;
- clean-artifact Python and TypeScript StateGraphs each commit an LLM and priced tool, then refuse the
  next paid node with zero refused dispatch in `langgraph-authoritative-sdk-e2e.test.ts`;
- the authenticated desktop/mobile Playwright journey seeds real reservations, settlements,
  refusals, projection, matching identities, and a blocked-only trace; and
- compatibility tests cover new SDK/old backend and old SDK/new backend behavior, unsupported
  capabilities, timeouts, and strict versus availability fallback.

These local tests still require source fixes and green URLs on the frozen candidate SHA under the
automated evidence checklist above. A local pass is not a release record.

## External gates that still need dedicated evidence

- [ ] Record a production-like scheduler rehearsal for expiry, projection, and daily audit-partition
      runway maintenance, including missed ticks, overlap, retry, and alert delivery.
- [ ] Provide and rehearse restricted one-off tasks for the PostgreSQL general/budget provisioners
      and ClickHouse RBAC provisioner. Record the immutable image or source digest, actor, redacted
      target, exit status, and success marker; verify migration/provisioning credentials are never
      injected into the application runtime.
- [ ] Record a shadow comparison period and an internal canary using the rollout checklist.
- [ ] Provide and rehearse an audited, authenticated operator API or command for
      `createBudgetControlCutover`, `refreshBudgetControlCutover`, and `markBudgetControlReady`.
      Direct SQL updates to `budget_control_cutovers` are not acceptable evidence.

These are stable-release blockers because they require deployment and operational evidence outside
the public source tree. They cannot be waived by renaming a job or by treating local tests as a
production rehearsal.

## Demonstration gate

The public demonstration may proceed before a stable package release only in an isolated internal
workspace and only when every item below is proven on the exact demo commit:

- [ ] One real LangGraph agent makes an LLM call and one priced non-LLM tool call.
- [ ] Both calls reserve before dispatch and commit their exact usage afterward.
- [ ] A deliberately small hard budget refuses the next paid operation.
- [ ] Instrumentation proves the refused provider/tool function ran zero times.
- [ ] PostgreSQL shows one decision per operation and one settlement per allowed reservation, with
      no duplicate billable legacy event.
- [ ] Projection retries converge to one logical ClickHouse contribution per authoritative event.
- [ ] The dashboard shows allowed spend and the refusal with matching identities.
- [ ] The demo runs `enforce` + `deny`; unknown pricing or bounds fail closed visibly.
- [ ] Every demo paid path is inventoried and uses a supported controlled integration. Demo code is
      cooperative; if any code is adversarial, provider credentials and egress are isolated behind
      the trusted reserve/dispatch/settle proxy.
- [ ] The expiry, projection, and audit-partition schedulers, alerts, kill switch, and rollback
      procedure are working in the demo environment.
- [ ] No prompt, completion, message body, tool arguments, credentials, or private payload content
      appears in telemetry or control evidence.

Passing the demo gate proves the launch asset. It does not approve the public stable SDKs.

## Stable 1.2.0 release gate

Stable release requires the candidate, automated, known-gap, rollout, and operations sections to be
complete for both languages. In addition:

- [ ] Every refusal path invokes the paid provider/tool zero times.
- [ ] A 100-way contention gate repeatedly authorizes exactly the mathematically available
      capacity and no more.
- [ ] Pooled and per-customer rules, overlapping rules, period rollover, retry, fallback, streaming,
      cancellation, crash, and late-commit behavior are covered.
- [ ] Unknown pricing, missing maximums, stale readiness, missing exact evidence, Redis failure,
      PostgreSQL failure, and ClickHouse failure have explicit expected outcomes.
- [ ] Forced RLS tenant isolation and public-route authentication/rate-limit/no-store behavior pass.
- [ ] General-app provisioning rejects a reused migration/budget login, dangerous role attributes,
      unexpected memberships, widened ownership/ACLs, authority access, or an ownership/time-zone
      upgrade precondition failure. The temporary owner bridge is not presented as the fully
      non-owner target design.
- [ ] Missing, reused, privileged, owner-reachable, or non-RLS budget-control credentials make
      capability readiness false and reserve/commit/release/extend return sanitized 503 responses.
- [ ] Missing, reused, or over-privileged ClickHouse projector credentials prevent authoritative
      projection; the general identity still cannot insert authoritative rows.
- [ ] Refusals never enter billable usage or invoices.
- [ ] Projection reconciliation shows no missing/conflicting/exhausted rows at the release watermark.
- [ ] Both SDKs return semantically equivalent decisions and expose documented error identities.
- [ ] Public SDK and operations documentation states that in-process control is a cooperative
      integration boundary, not a hostile-code sandbox; the production threat model records trusted
      application code or the required provider-credential/egress proxy isolation.
- [ ] Python async applications use each controlled provider facade and its streams on one
      operational event loop and await their shutdown before loop teardown.
- [ ] The final packed artifacts, not working-tree imports or independently rebuilt archives, are
      the bytes exercised by package and cross-runtime service tests.
- [ ] A release owner and rollback owner approve the recorded evidence.

## SDK prerelease procedure — currently blocked

The implementation plan requires paired SDK prereleases before stable 1.2.0. Do not create a
prerelease tag with the current workflows: TypeScript publishes without an explicit non-`latest`
dist-tag, both languages rebuild after candidate CI, and each publish workflow queries only the
focused workflow.

Before the first prerelease:

1. Use explicit SemVer/PEP 440 prerelease metadata in source and runtime version files.
2. Publish npm with an approved non-`latest` dist-tag such as `next`, and verify that `latest` remains
   unchanged.
3. Publish Python under its PEP 440 prerelease version and verify that ordinary stable installation
   does not select it without prerelease opt-in.
4. Require successful focused, fast/security, integration, and E2E workflow records for the exact
   merged SHA.
5. Publish the service-tested artifacts, or rerun every immutable package and cross-runtime service
   gate on the newly built hashes before upload.
6. Record package URLs, provenance, digests, clean prerelease installations, and rollback owners.

## Tag and publish procedure

Only after every stable gate is approved:

1. Re-read the versions from the merged metadata and verify the tags do not already exist.
2. Confirm the candidate commit is an ancestor of `origin/main`.
3. Confirm the exact candidate SHA has recorded green focused, fast/security, integration, and E2E
   workflow URLs.
4. Create the TypeScript tag as `pylva-ts-v${TS_VERSION}` and the Python tag as
   `pylva-py-v${PY_VERSION}` from that approved commit.
5. Require the tag workflows to publish the approved artifacts, or rebuild once and rerun the full
   artifact/service evidence against the new hashes. Do not run a parallel manual upload.
6. Verify registry provenance, package metadata, clean consumer installation, ESM/CJS imports,
   Python import/version, and the documented legacy default.
7. Record package URLs, digests, workflow URLs, and the commit SHA in the release record.

Publishing and tagging are intentionally outside this groundwork task.

## Release rollback

Published versions are immutable evidence. Do not overwrite, force-move a tag, or depend on
unpublishing as rollback.

For an SDK defect, stop rollout, move clients to the last known-good version/configuration, and ship
a reviewed patch version. For an authority defect, follow the rollout guide's client-first
availability rollback or strict traffic-stop procedure. Keep lifecycle/projection workers running
and preserve the ledger for reconciliation.

## Enforcement defaults belong to a future major

Every 1.x release, including 1.2.x, must keep `legacy` + availability-compatible defaults. A minor
or patch release must never begin blocking paid operations without explicit configuration.

Changing the default requires a future major release and all of the following before approval:

- adoption evidence from stable opt-in 1.x users across both languages;
- a prior deprecation period and a migration guide explaining reserve/settle ordering;
- automatic detection of unsupported/disabled backends with unambiguous errors;
- proven lifecycle schedulers, exact/next-period readiness, rollback, and customer support playbooks;
- cross-language, old/new compatibility, chaos, and packed-artifact gates;
- an explicit decision on whether the major defaults first to `shadow` or directly to
  `enforce` + `deny`; an `enforce` default paired with silent availability fallback is not reliable
  enforcement;
- a documented temporary opt-out for applications that cannot yet pre-bound every paid operation;
  and
- separate release approval that treats the behavior change as breaking, even if API signatures do
  not change.

Until that major is approved, examples may demonstrate strict opt-in control, but package defaults
must remain non-blocking and backward compatible.
