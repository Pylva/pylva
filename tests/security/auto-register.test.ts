// B3-T4a — ingest auto-register + debounced last_seen_at.
//
// Runs under `pnpm test:integration` (hits real Postgres).
// Verifies:
//   * `recordSourceSighting` inserts a new `cost_sources` row with
//     source_type='llm_provider' for an unseen provider.
//   * A second call for the same (builder, provider) is a no-op at the DB
//     layer (`ON CONFLICT DO NOTHING`), so the display_name from the first
//     sighting is preserved.
//   * `flushLastSeenBuffer()` pushes buffered timestamps to PostgreSQL and
//     advances the `last_seen_at` column.
//   * Slug normalization matches the server-side `slugify`: simple existing
//     slugs are preserved, transformed/arbitrary providers get a stable hash
//     suffix, and providers that produce no ASCII slug still register.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import postgres from 'postgres';
import crypto from 'node:crypto';
import {
  recordSourceSighting,
  flushLastSeenBuffer,
  _resetBufferForTests,
} from '../../src/lib/ingest/last-seen-buffer.js';

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgresql://pylva:pylva_dev@localhost:5432/pylva';

let sql: ReturnType<typeof postgres>;
let builderId: string;

function expectedSlug(provider: string): string {
  const trimmed = provider.trim();
  const base = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const hash = crypto.createHash('sha256').update(provider).digest('hex').slice(0, 12);
  if (base.length > 0 && base.length <= 100 && trimmed === base) return base;
  if (base.length === 0) return `provider-${hash}`;
  return `${base.slice(0, 87).replace(/-+$/g, '') || 'provider'}-${hash}`;
}

beforeAll(async () => {
  sql = postgres(DATABASE_URL);
  const slug = `auto-register-${crypto.randomBytes(4).toString('hex')}`;
  const [b] = await sql<{ id: string }[]>`
    INSERT INTO builders (email, name, tier, slug)
    VALUES (${`test-auto-register-${crypto.randomBytes(4).toString('hex')}@test.com`}, 'Auto Register Test', 'free', ${slug})
    RETURNING id
  `;
  builderId = b!.id;
});

afterAll(async () => {
  await sql`DELETE FROM cost_sources WHERE builder_id = ${builderId}`;
  await sql`DELETE FROM builders WHERE id = ${builderId}`;
  await sql.end();
});

beforeEach(async () => {
  await sql`DELETE FROM cost_sources WHERE builder_id = ${builderId}`;
  _resetBufferForTests();
});

describe('recordSourceSighting auto-registration', () => {
  it('creates a cost_sources row with source_type=llm_provider for a new provider', async () => {
    await recordSourceSighting(builderId, 'openai');
    const rows = await sql<{ slug: string; source_type: string; display_name: string }[]>`
      SELECT slug, source_type, display_name FROM cost_sources WHERE builder_id = ${builderId}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      slug: 'openai',
      source_type: 'llm_provider',
      display_name: 'openai',
    });
  });

  it('is idempotent — a second call does not create a duplicate row', async () => {
    await recordSourceSighting(builderId, 'anthropic');
    await recordSourceSighting(builderId, 'anthropic');
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM cost_sources WHERE builder_id = ${builderId} AND slug = 'anthropic'
    `;
    expect(rows).toHaveLength(1);
  });

  it('creates a stable slug for providers with punctuation', async () => {
    await recordSourceSighting(builderId, 'Google Gemini');
    const rows = await sql<{ slug: string; display_name: string }[]>`
      SELECT slug, display_name FROM cost_sources WHERE builder_id = ${builderId}
    `;
    expect(rows[0]!.slug).toBe(expectedSlug('Google Gemini'));
    // display_name preserves the original casing from the ingest event.
    expect(rows[0]!.display_name).toBe('Google Gemini');
  });

  it('distinguishes arbitrary providers that share a readable slug', async () => {
    await recordSourceSighting(builderId, 'openai.chat');
    await recordSourceSighting(builderId, 'openai/chat');
    const rows = await sql<{ slug: string; display_name: string }[]>`
      SELECT slug, display_name FROM cost_sources WHERE builder_id = ${builderId}
      ORDER BY display_name
    `;
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.slug).sort()).toEqual(
      [expectedSlug('openai.chat'), expectedSlug('openai/chat')].sort(),
    );
  });

  it('creates a stable fallback slug when provider punctuation slugifies to empty', async () => {
    await recordSourceSighting(builderId, '@@@');
    const rows = await sql<{ slug: string; display_name: string }[]>`
      SELECT slug, display_name FROM cost_sources WHERE builder_id = ${builderId}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.slug).toBe(expectedSlug('@@@'));
    expect(rows[0]!.display_name).toBe('@@@');
  });
});

describe('flushLastSeenBuffer', () => {
  it('advances last_seen_at on the existing row', async () => {
    await recordSourceSighting(builderId, 'openai');

    const [before] = await sql<{ last_seen_at: Date | null }[]>`
      SELECT last_seen_at FROM cost_sources WHERE builder_id = ${builderId} AND slug = 'openai'
    `;
    // Row exists via auto-register, but the debounced UPDATE hasn't been
    // flushed yet, so last_seen_at remains null until flush.
    expect(before!.last_seen_at).toBeNull();

    await flushLastSeenBuffer();

    const [after] = await sql<{ last_seen_at: Date | null }[]>`
      SELECT last_seen_at FROM cost_sources WHERE builder_id = ${builderId} AND slug = 'openai'
    `;
    expect(after!.last_seen_at).not.toBeNull();
    expect(new Date(after!.last_seen_at!).getTime()).toBeGreaterThan(Date.now() - 10_000);
  });

  it('is safe to call with an empty buffer', async () => {
    await expect(flushLastSeenBuffer()).resolves.toBeUndefined();
  });
});
