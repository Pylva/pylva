import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('src/app/api/cron/expire-budget-reservations/route.ts', 'utf8');

describe('authoritative budget expiry cron source boundary', () => {
  it('uses shared constant-time cron authentication', () => {
    expect(source).toContain('verifyCronSecret(request)');
  });

  it('keeps lifecycle maintenance independent of the new-reservation kill switch', () => {
    expect(source).not.toContain('ENABLE_AUTHORITATIVE_BUDGET_CONTROL');
    expect(source).toContain('strand holds that already exist');
  });

  it('turns an all-builders failure into a retryable route failure', () => {
    expect(source).toContain('allScannedBuildersFailed(result)');
    expect(source).toContain(
      "internalError('budget reservation expiry failed for all scanned builders')",
    );
  });

  it('exports both scheduler verbs and disables response caching', () => {
    expect(source).toContain('export async function POST');
    expect(source).toContain('export async function GET');
    expect(source).toContain("export const runtime = 'nodejs'");
    expect(source).toContain("export const dynamic = 'force-dynamic'");
    expect(source).toContain("'Cache-Control': 'no-store'");
    expect(source).toContain('noStore(authError');
    expect(source).toContain('noStore(internalError');
  });

  it('does not copy exception messages into logs or responses', () => {
    expect(source).not.toContain('error.message');
    expect(source).not.toContain('String(error)');
    expect(source).toContain('error.name');
  });
});
