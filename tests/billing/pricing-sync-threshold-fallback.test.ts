// Regression: the scheduled pricing sync must invoke the committed snapshot
// automatically on the third consecutive LiteLLM failure. Without this, the
// route only recorded the failure and live pricing could drift indefinitely.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  verifyCronSecret: vi.fn(() => true),
  runLitellmSync: vi.fn(),
  syncFromSnapshot: vi.fn(),
  runBackupPriceWatcher: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('../../src/lib/cron/auth.js', () => ({
  verifyCronSecret: mocks.verifyCronSecret,
}));

vi.mock('../../src/lib/pricing/litellm-sync.js', () => ({
  runLitellmSync: mocks.runLitellmSync,
  syncFromSnapshot: mocks.syncFromSnapshot,
}));

vi.mock('../../src/lib/rules/backup-price-watcher.js', () => ({
  runBackupPriceWatcher: mocks.runBackupPriceWatcher,
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    child: () => ({
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    }),
  },
}));

const { POST } = await import('../../src/app/api/cron/pricing-sync/route.js');

function request(query = ''): import('next/server.js').NextRequest {
  return new Request(`http://localhost/api/cron/pricing-sync${query}`, {
    method: 'POST',
  }) as unknown as import('next/server.js').NextRequest;
}

function aborted(attemptNumber: number) {
  return {
    status: 'aborted' as const,
    synced: 0,
    skipped: 0,
    failure_reason: 'upstream unavailable',
    attempt_number: attemptNumber,
    source: 'litellm' as const,
  };
}

const snapshotSuccess = {
  status: 'success' as const,
  synced: 12,
  skipped: 0,
  attempt_number: 4,
  source: 'snapshot' as const,
};

describe('pricing sync automatic snapshot fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verifyCronSecret.mockReturnValue(true);
    mocks.runBackupPriceWatcher.mockResolvedValue(null);
    mocks.syncFromSnapshot.mockResolvedValue(snapshotSuccess);
  });

  it('applies the snapshot after the third consecutive LiteLLM failure', async () => {
    mocks.runLitellmSync.mockResolvedValue(aborted(3));

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(mocks.syncFromSnapshot).toHaveBeenCalledTimes(1);
    await expect(response.json()).resolves.toMatchObject({
      status: 'success',
      source: 'snapshot',
      synced: 12,
    });
  });

  it('does not apply the snapshot before the failure threshold', async () => {
    mocks.runLitellmSync.mockResolvedValue(aborted(2));

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(mocks.syncFromSnapshot).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      status: 'aborted',
      source: 'litellm',
      attempt_number: 2,
    });
  });

  it('does not loop the automatic fallback after a failed snapshot advances the streak', async () => {
    mocks.runLitellmSync.mockResolvedValue(aborted(4));

    await POST(request());

    expect(mocks.syncFromSnapshot).not.toHaveBeenCalled();
  });

  it('keeps the explicit snapshot recovery path available', async () => {
    const response = await POST(request('?fallback=snapshot'));

    expect(response.status).toBe(200);
    expect(mocks.runLitellmSync).not.toHaveBeenCalled();
    expect(mocks.syncFromSnapshot).toHaveBeenCalledTimes(1);
  });
});
