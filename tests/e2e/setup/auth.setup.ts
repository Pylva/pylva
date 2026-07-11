// Authenticated-dashboard bootstrap for Playwright (gated by E2E_DASHBOARD).
//
// There is no login-form path in CI (magic links go out via Resend email), so
// this setup project mints a REAL session JWT with the same private key the
// server verifies against (CI generates a throwaway RSA pair; locally .keys/
// from `pnpm db:setup`). No product code is bypassed: the middleware performs
// its normal RS256 + membership checks. Anyone able to run this already holds
// the private key file, so this adds no attack surface.
//
// Steps: upsert an e2e user + owner membership on the seeded `alice-free`
// builder (db/seed.ts), sign the dashboard JWT (mirrors signJwt in
// src/lib/auth/jwt.ts), then persist a storageState cookie for the dashboard
// specs to consume via test.use({ storageState: DASHBOARD_STORAGE_STATE }).

import { test as setup } from '@playwright/test';
import { SignJWT, importPKCS8 } from 'jose';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import postgres from 'postgres';
import { DASHBOARD_ORG_SLUG, DASHBOARD_STORAGE_STATE } from './fixtures';

const E2E_USER_EMAIL = 'e2e-dashboard@pylva.test';
// Same string as JwtAudience.DASHBOARD in packages/shared/src/types/auth.ts.
const DASHBOARD_AUDIENCE = 'pylva:dashboard';

setup.skip(!process.env.E2E_DASHBOARD, 'dashboard e2e requires E2E_DASHBOARD + a seeded stack');

setup('mint dashboard session', async ({ browser, baseURL }) => {
  const databaseUrl =
    process.env.DATABASE_URL ?? 'postgresql://pylva:pylva_dev@localhost:5432/pylva';
  const privateKeyPath = process.env.JWT_PRIVATE_KEY ?? '.keys/private.pem';
  const cookieName = process.env.SESSION_COOKIE_NAME ?? 'pylva_session';

  const sql = postgres(databaseUrl);
  try {
    const builders = await sql`
      SELECT id, tier FROM builders WHERE slug = ${DASHBOARD_ORG_SLUG} LIMIT 1
    `;
    if (builders.length === 0) {
      throw new Error(
        `builder "${DASHBOARD_ORG_SLUG}" not found — run \`pnpm db:seed\` before the e2e suite`,
      );
    }
    const builder = builders[0]!;

    const users = await sql`
      INSERT INTO users (email, display_name)
      VALUES (${E2E_USER_EMAIL}, 'E2E Dashboard')
      ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name
      RETURNING id
    `;
    const userId = users[0]!.id as string;

    await sql`
      INSERT INTO user_builder_memberships (user_id, builder_id, role)
      VALUES (${userId}, ${builder.id as string}, 'owner')
      ON CONFLICT (user_id, builder_id) DO UPDATE SET role = 'owner'
    `;

    const pem = await fs.readFile(privateKeyPath, 'utf-8');
    const privateKey = await importPKCS8(pem, 'RS256');
    const token = await new SignJWT({
      builder_id: builder.id as string,
      user_id: userId,
      role: 'owner',
      tier: (builder.tier as string | null) ?? 'free',
    })
      .setProtectedHeader({ alg: 'RS256' })
      .setJti(crypto.randomUUID())
      .setAudience(DASHBOARD_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('24h')
      .sign(privateKey);

    const origin = new URL(baseURL ?? 'http://localhost:3000');
    const context = await browser.newContext();
    await context.addCookies([
      {
        name: cookieName,
        value: token,
        domain: origin.hostname,
        path: '/',
        httpOnly: true,
        secure: origin.protocol === 'https:',
        sameSite: 'Lax',
      },
    ]);
    await fs.mkdir(path.dirname(DASHBOARD_STORAGE_STATE), { recursive: true });
    await context.storageState({ path: DASHBOARD_STORAGE_STATE });
    await context.close();
  } finally {
    await sql.end();
  }
});
