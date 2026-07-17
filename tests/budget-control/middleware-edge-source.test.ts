import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

async function middlewareSource(): Promise<string> {
  return fs.readFile(path.resolve(process.cwd(), 'src/middleware.ts'), 'utf8');
}

async function authMiddlewareSource(): Promise<string> {
  return fs.readFile(path.resolve(process.cwd(), 'src/lib/auth/middleware.ts'), 'utf8');
}

describe('authoritative budget-control middleware source boundary', () => {
  it('dispatches the machine-only classifier before the dashboard JWT fallback', async () => {
    const source = await middlewareSource();
    const controlDispatch = source.indexOf('if (isAuthoritativeBudgetControlPath(pathname))');
    const dashboardFallback = source.indexOf("if (pathname.startsWith('/api/v1/'))");

    expect(controlDispatch).toBeGreaterThan(-1);
    expect(dashboardFallback).toBeGreaterThan(controlDispatch);
  });

  it('uses a dedicated control bucket and the API-key context injector', async () => {
    const source = await middlewareSource();
    const handlerStart = source.indexOf('async function handleApiKeyAuth');
    const middlewareStart = source.indexOf('export async function middleware');
    const apiKeyHandler = source.slice(handlerStart, middlewareStart);

    expect(source).toContain(
      "handleApiKeyAuth(request, 'budget_control', RATE_LIMIT_PRESETS.budgetControl, true)",
    );
    expect(handlerStart).toBeGreaterThan(-1);
    expect(middlewareStart).toBeGreaterThan(handlerStart);
    expect(apiKeyHandler).toMatch(
      /const response = nextWithContext\(request, \{[\s\S]*?'x-builder-id': authResult\.builderId,[\s\S]*?'x-key-id': authResult\.keyId/,
    );
  });

  it('gives the reserve-and-settle hot path a 600-per-minute isolated preset', async () => {
    const source = await authMiddlewareSource();

    expect(source).toContain(
      'budgetControl: { maxRequests: 600, windowMs: 60_000 } satisfies RateLimitConfig',
    );
    expect(source).toContain(
      'controlPlane: { maxRequests: 100, windowMs: 60_000 } satisfies RateLimitConfig',
    );
  });

  it('does not condition API-key authentication on the rollout flag or HTTP method', async () => {
    const source = await middlewareSource();
    const controlDispatch = source.indexOf('if (isAuthoritativeBudgetControlPath(pathname))');
    const nextRouteGroup = source.indexOf('// SDK-facing routes', controlDispatch);
    const controlBlock = source.slice(controlDispatch, nextRouteGroup);

    expect(controlBlock).not.toContain('ENABLE_AUTHORITATIVE_BUDGET_CONTROL');
    expect(controlBlock).not.toContain('request.method');
    expect(controlBlock).toContain('handleApiKeyAuth');
    expect(controlBlock).toContain('RATE_LIMIT_PRESETS.budgetControl, true');
  });

  it('marks every control-path outcome non-cacheable, including forwarding', async () => {
    const source = await middlewareSource();
    const handlerStart = source.indexOf('async function handleApiKeyAuth');
    const middlewareStart = source.indexOf('export async function middleware');
    const apiKeyHandler = source.slice(handlerStart, middlewareStart);

    expect(apiKeyHandler).toContain("authResult.headers.set('Cache-Control', 'no-store')");
    expect(apiKeyHandler).toContain("rateLimitResult.headers.set('Cache-Control', 'no-store')");
    expect(apiKeyHandler).toContain("response.headers.set('Cache-Control', 'no-store')");
  });
});
