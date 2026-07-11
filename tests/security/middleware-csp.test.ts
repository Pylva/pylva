// Static analysis of src/middleware.ts. We pin the CSP behavior that the
// runtime tests would prove dynamically — but at this layer we can fail fast
// before any browser is involved.

import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MIDDLEWARE_PATH = path.join(REPO_ROOT, 'src', 'middleware.ts');

async function middlewareSource(): Promise<string> {
  return fs.readFile(MIDDLEWARE_PATH, 'utf8');
}

describe('src/middleware.ts — CSP + security headers', () => {
  it('sets Content-Security-Policy on the portal surface', async () => {
    const src = await middlewareSource();
    // Either a literal header set or a buildPortalFrameAncestors call.
    expect(src).toMatch(/Content-Security-Policy/);
    expect(src).toMatch(/pathname\.startsWith\(['"]\/portal/);
  });

  it('sets Referrer-Policy: no-referrer on the portal surface', async () => {
    const src = await middlewareSource();
    expect(src).toMatch(/Referrer-Policy['"]?\s*,\s*['"]no-referrer/);
  });

  it('routes Stripe webhook traffic past the JWT/API-key gate', async () => {
    // Stripe webhooks authenticate via signature, not JWT.
    const src = await middlewareSource();
    expect(src).toMatch(/api\/v1\/billing\/webhooks/);
  });

  it('public auth entrypoints are explicitly enumerated', async () => {
    const src = await middlewareSource();
    expect(src).toMatch(/api\/v1\/auth\/oauth/);
    expect(src).toMatch(/api\/v1\/auth\/magic\/request/);
    expect(src).toMatch(/api\/v1\/auth\/magic\/verify/);
    expect(src).toMatch(/api\/v1\/invites\/accept/);
  });
});
