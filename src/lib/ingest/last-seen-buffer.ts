// B3-T4a — debounced cost_sources.last_seen_at updater (D30).
// In-memory Map keyed by `${builderId}:${slug}`. Flushed every 60s (or on
// process exit) to PostgreSQL. Up to 60s of staleness is acceptable for the
// hourly health cron (spec §14 risk matrix row #6).

import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { costSources } from '../db/schema.js';

type Key = `${string}:${string}`;

const buffer = new Map<Key, Date>();
const FLUSH_INTERVAL_MS = 60_000;
const MAX_SLUG_LENGTH = 100;
const SLUG_HASH_LENGTH = 12;
let timer: NodeJS.Timeout | null = null;

type LastSeenGlobal = typeof globalThis & {
  __pylvaLastSeenShutdownHooked?: boolean;
};

const lastSeenGlobal = globalThis as LastSeenGlobal;

function slugify(s: string): string {
  const trimmed = s.trim();
  const base = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (base.length > 0 && base.length <= MAX_SLUG_LENGTH && trimmed === base) return base;

  const hash = createHash('sha256').update(s).digest('hex').slice(0, SLUG_HASH_LENGTH);
  if (base.length === 0) return `provider-${hash}`;

  const maxBaseLength = MAX_SLUG_LENGTH - SLUG_HASH_LENGTH - 1;
  const truncatedBase = base.slice(0, maxBaseLength).replace(/-+$/g, '') || 'provider';
  return `${truncatedBase}-${hash}`;
}

function keyOf(builderId: string, slug: string): Key {
  return `${builderId}:${slug}`;
}

/**
 * Record that a builder just emitted an event for a given provider/source.
 * Auto-registers the LLM provider if not yet present (INSERT ON CONFLICT DO NOTHING).
 * The last_seen_at UPDATE is buffered — flushed every 60s.
 */
export async function recordSourceSighting(builderId: string, provider: string): Promise<void> {
  const slug = slugify(provider);

  // D29: ingest-time auto-register. Safe under concurrent writers (ON CONFLICT).
  try {
    await db
      .insert(costSources)
      .values({
        builder_id: builderId,
        source_type: 'llm_provider',
        display_name: provider,
        slug,
        tracking_status: 'tracked',
        matchers: [slug],
      })
      .onConflictDoNothing({ target: [costSources.builder_id, costSources.slug] });
  } catch {
    // R1 — never fail ingest due to the auto-register side effect.
    return;
  }

  buffer.set(keyOf(builderId, slug), new Date());
  ensureFlushTimer();
}

function ensureFlushTimer(): void {
  if (timer) return;
  timer = setInterval(() => void flushLastSeenBuffer(), FLUSH_INTERVAL_MS);
  timer.unref?.();
  if (!lastSeenGlobal.__pylvaLastSeenShutdownHooked) {
    lastSeenGlobal.__pylvaLastSeenShutdownHooked = true;
    process.on('SIGTERM', () => void flushLastSeenBuffer());
    process.on('SIGINT', () => void flushLastSeenBuffer());
  }
}

export async function flushLastSeenBuffer(): Promise<void> {
  if (buffer.size === 0) return;
  const snapshot = Array.from(buffer.entries());
  buffer.clear();
  for (const [key, seenAt] of snapshot) {
    const [builderId, slug] = key.split(':', 2) as [string, string];
    try {
      await db
        .update(costSources)
        .set({ last_seen_at: seenAt })
        .where(and(eq(costSources.builder_id, builderId), eq(costSources.slug, slug)));
    } catch {
      // Non-fatal: we'll get the next event's timestamp on the next flush.
    }
  }
}

// Test helper.
export function _resetBufferForTests(): void {
  buffer.clear();
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
