# Contributing To Pylva

Thanks for helping improve Pylva. Keep PRs small, focused, and easy to review.

## Dev Setup

Prerequisites:

- Node.js 20.18.1 or newer
- pnpm 10.31.0, matching `packageManager` in `package.json`
- Docker with Docker Compose

Start local services from the repo root:

```bash
docker compose -f docker/docker-compose.yml up -d
```

Install dependencies:

```bash
pnpm install
```

Create your local environment file:

```bash
cp .env.example .env
```

Set `RESEND_API_KEY` if you need to exercise magic-link, invite, alert, or tier-limit email delivery locally.

Run migrations and seed data:

```bash
pnpm db:setup
pnpm db:seed
```

Start the app:

```bash
pnpm dev
```

The local compose file is `docker/docker-compose.yml`; it starts the development services Pylva needs.

## Test Commands

Run the relevant checks before opening a PR:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm test:integration
pnpm test:e2e
```

The default PR gate is typecheck, lint, unit tests, and the deterministic external-egress socket test on Node 20 and Node 22. `pnpm test:integration` requires the PostgreSQL, ClickHouse, and Redis services from Docker Compose. Run E2E tests for browser-facing changes or when a maintainer asks for them.

For DNS, Undici dispatcher, OAuth transport, or outbound-network changes, run the real-socket regression directly:

```bash
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/external-egress-transport.test.ts
```

`pnpm check:external-egress` makes credential-free requests to the GitHub and Google token hosts. Use it for deployment or explicit live-egress validation, not as a replacement for deterministic tests.

## PR Flow

1. Fork the repository.
2. Create a branch for one focused change.
3. Keep `pnpm typecheck`, `pnpm lint`, and `pnpm test` green.
4. Update docs or tests when behavior changes.
5. Open a PR with a clear summary and test evidence.

Your first PR triggers a CLA signature request via cla-assistant. Please complete it before review.

## Where To Ask

- Slack community: <https://join.slack.com/t/pylva/shared_invite/zt-4357amddc-QvNEhpxYU~6DyrF5P6Cw8Q>
- GitHub issues: bugs, feature requests, and self-hosting questions that should be public and searchable
