import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getSecretString: vi.fn() }));

vi.mock('../../src/lib/aws/secrets.js', () => ({ getSecretString: mocks.getSecretString }));

const { getBudgetControlDbPassword, _resetBudgetControlCredentialCache } =
  await import('../../src/lib/budget-control/credentials.js');

beforeEach(() => {
  vi.useFakeTimers();
  mocks.getSecretString.mockReset();
  _resetBudgetControlCredentialCache();
});

afterEach(() => vi.useRealTimers());

describe('budget-control rotating database credential', () => {
  it('returns and caches a password only for the URL-bound username', async () => {
    mocks.getSecretString.mockResolvedValue(
      JSON.stringify({ username: 'pylva_budget_login', password: 'pw-1' }),
    );

    await expect(
      getBudgetControlDbPassword('arn:test:budget-runtime', 'pylva_budget_login'),
    ).resolves.toBe('pw-1');
    await expect(
      getBudgetControlDbPassword('arn:test:budget-runtime', 'pylva_budget_login'),
    ).resolves.toBe('pw-1');
    expect(mocks.getSecretString).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the secret username does not match the URL login', async () => {
    mocks.getSecretString.mockResolvedValue(
      JSON.stringify({ username: 'migration_owner', password: 'privileged' }),
    );
    await expect(
      getBudgetControlDbPassword('arn:test:wrong-secret', 'pylva_budget_login'),
    ).rejects.toThrow('username does not match');
  });

  it('rejects malformed and passwordless secrets', async () => {
    mocks.getSecretString.mockResolvedValueOnce('{not-json');
    await expect(
      getBudgetControlDbPassword('arn:test:malformed', 'pylva_budget_login'),
    ).rejects.toThrow('not valid JSON');

    mocks.getSecretString.mockResolvedValueOnce(JSON.stringify({ username: 'pylva_budget_login' }));
    await expect(
      getBudgetControlDbPassword('arn:test:passwordless', 'pylva_budget_login'),
    ).rejects.toThrow('missing a password');
  });

  it('does not serve a stale password after a refresh failure', async () => {
    mocks.getSecretString.mockResolvedValueOnce(
      JSON.stringify({ username: 'pylva_budget_login', password: 'pw-1' }),
    );
    await getBudgetControlDbPassword('arn:test:budget-runtime', 'pylva_budget_login');

    vi.advanceTimersByTime(31_000);
    mocks.getSecretString.mockRejectedValueOnce(new Error('AccessDenied'));
    await expect(
      getBudgetControlDbPassword('arn:test:budget-runtime', 'pylva_budget_login'),
    ).rejects.toThrow('AccessDenied');
  });
});
