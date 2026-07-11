# LICENSE-MAP

Unless otherwise stated here, all files in this repository are licensed under
the MIT License in [LICENSE](LICENSE). The exceptions listed below are licensed
under the Elastic License 2.0; the full ELv2 text is in
[src/ee/LICENSE](src/ee/LICENSE).

## Elastic License 2.0 Paths

- `src/lib/billing/**`
- `src/lib/stripe/**`
- `src/lib/portal/**`
- `src/app/api/v1/billing/**`
- `src/app/api/v1/portal/**`
- `src/app/api/portal/**`
- `src/app/portal/**`
- `src/app/api/cron/generate-monthly-drafts/**`
- `src/app/api/cron/notify-pending-drafts/**`
- `src/app/api/cron/purge-invoice-idempotency/**`
- `src/app/o/[slug]/dashboard/billing/**`
- `src/app/o/[slug]/dashboard/settings/billing/**`
- `src/app/o/[slug]/dashboard/settings/portal/**`
- `src/components/billing/**`
- `src/components/settings/PortalConfigClient.tsx`
- `src/components/dashboard/DraftBanner.tsx`
- `scripts/generate-monthly-drafts.ts`
- `scripts/purge-invoice-idempotency.ts`

## Explicit MIT-Stays Notes

The path list above is intentionally narrow. `packages/shared/**` remains MIT,
including billing and portal types. `db/migrations/**` remains MIT. All tests
remain MIT. `src/lib/auth/tier-enforcement.ts` and `src/lib/alerts/**`
remain MIT. Marketing components and marketing pages
remain MIT.

## Rationale

The Elastic License 2.0 allows use, copy, modification, and redistribution of
the listed Bill pillar code, but does not allow offering that licensed code to
third parties as a hosted or managed service, and does not allow removing
license-key or entitlement functionality. This paragraph is a summary only;
the license text in [src/ee/LICENSE](src/ee/LICENSE) controls the ELv2 terms.
