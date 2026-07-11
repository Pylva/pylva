// Runtime DB password provider — survives RDS-managed master-password rotation.
// Verifies: fetch + TTL cache, rotation pickup after TTL, graceful stale-serve
// on a transient Secrets Manager error, and hard failures (no ARN / no cache).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSecretString: vi.fn(),
  warn: vi.fn(),
  env: { DB_MASTER_USER_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:1:secret:rds-master' } as {
    DB_MASTER_USER_SECRET_ARN: string | undefined;
  },
}));

vi.mock('@/lib/aws/secrets', () => ({ getSecretString: mocks.getSecretString }));
vi.mock('@/lib/config', () => ({ env: mocks.env }));
vi.mock('@/lib/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: mocks.warn, error: vi.fn() }) },
}));

import { getDbPassword, _resetDbCredentialCache } from '@/lib/db/credentials';

// JSON.stringify drops an undefined password, so secretJson(undefined) yields
// a secret with no password field (the "missing password" case).
const secretJson = (password: string | undefined, username = 'pylva') =>
  JSON.stringify({ username, password });

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.useFakeTimers();
  _resetDbCredentialCache();
  mocks.getSecretString.mockReset();
  mocks.warn.mockReset();
  mocks.env.DB_MASTER_USER_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:1:secret:rds-master';
});

afterEach(() => {
  vi.useRealTimers();
});

describe('getDbPassword', () => {
  it('fetches and parses the password from the RDS master secret', async () => {
    mocks.getSecretString.mockResolvedValue(secretJson('pw1'));
    await expect(getDbPassword()).resolves.toBe('pw1');
    expect(mocks.getSecretString).toHaveBeenCalledTimes(1);
    expect(mocks.getSecretString).toHaveBeenCalledWith(
      'arn:aws:secretsmanager:us-east-1:1:secret:rds-master',
    );
  });

  it('serves the cached password within the TTL (no second fetch)', async () => {
    mocks.getSecretString.mockResolvedValue(secretJson('pw1'));
    await getDbPassword();
    vi.advanceTimersByTime(5_000);
    await expect(getDbPassword()).resolves.toBe('pw1');
    expect(mocks.getSecretString).toHaveBeenCalledTimes(1);
  });

  it('refetches after the TTL and picks up a rotated password', async () => {
    mocks.getSecretString.mockResolvedValueOnce(secretJson('pw1'));
    await expect(getDbPassword()).resolves.toBe('pw1');

    // Simulate AWS rotating the password; advance past the TTL.
    mocks.getSecretString.mockResolvedValueOnce(secretJson('pw2-rotated'));
    vi.advanceTimersByTime(31_000);
    await expect(getDbPassword()).resolves.toBe('pw2-rotated');
    expect(mocks.getSecretString).toHaveBeenCalledTimes(2);
  });

  it('deduplicates concurrent refreshes after the TTL', async () => {
    mocks.getSecretString.mockResolvedValueOnce(secretJson('pw1'));
    await expect(getDbPassword()).resolves.toBe('pw1');

    vi.advanceTimersByTime(31_000);
    const refresh = deferred<string>();
    mocks.getSecretString.mockReturnValueOnce(refresh.promise);

    const first = getDbPassword();
    const second = getDbPassword();
    expect(mocks.getSecretString).toHaveBeenCalledTimes(2);

    refresh.resolve(secretJson('pw2-rotated'));
    await expect(Promise.all([first, second])).resolves.toEqual(['pw2-rotated', 'pw2-rotated']);
    expect(mocks.getSecretString).toHaveBeenCalledTimes(2);
  });

  it('serves the last-known-good password when a refresh fails (transient SM blip)', async () => {
    mocks.getSecretString.mockResolvedValueOnce(secretJson('pw1'));
    await getDbPassword();

    mocks.getSecretString.mockRejectedValueOnce(new Error('ThrottlingException'));
    vi.advanceTimersByTime(31_000);
    await expect(getDbPassword()).resolves.toBe('pw1');
    expect(mocks.warn).toHaveBeenCalledTimes(1);
  });

  it('backs off stale-serve retries after a refresh failure', async () => {
    mocks.getSecretString.mockResolvedValueOnce(secretJson('pw1'));
    await expect(getDbPassword()).resolves.toBe('pw1');

    mocks.getSecretString.mockRejectedValueOnce(new Error('ThrottlingException'));
    vi.advanceTimersByTime(31_000);
    await expect(getDbPassword()).resolves.toBe('pw1');
    expect(mocks.getSecretString).toHaveBeenCalledTimes(2);
    expect(mocks.warn).toHaveBeenCalledTimes(1);

    await expect(getDbPassword()).resolves.toBe('pw1');
    expect(mocks.getSecretString).toHaveBeenCalledTimes(2);
    expect(mocks.warn).toHaveBeenCalledTimes(1);

    mocks.getSecretString.mockResolvedValueOnce(secretJson('pw2-rotated'));
    vi.advanceTimersByTime(31_000);
    await expect(getDbPassword()).resolves.toBe('pw2-rotated');
    expect(mocks.getSecretString).toHaveBeenCalledTimes(3);
  });

  it('throws when the secret refresh fails and there is no cached password', async () => {
    mocks.getSecretString.mockRejectedValueOnce(new Error('AccessDeniedException'));
    await expect(getDbPassword()).rejects.toThrow(/AccessDeniedException/);
  });

  it('throws when the secret has no password field', async () => {
    mocks.getSecretString.mockResolvedValueOnce(secretJson(undefined));
    await expect(getDbPassword()).rejects.toThrow(/missing password/);
  });

  it('throws when DB_MASTER_USER_SECRET_ARN is unset', async () => {
    mocks.env.DB_MASTER_USER_SECRET_ARN = undefined;
    await expect(getDbPassword()).rejects.toThrow(/DB_MASTER_USER_SECRET_ARN is not set/);
    expect(mocks.getSecretString).not.toHaveBeenCalled();
  });
});
