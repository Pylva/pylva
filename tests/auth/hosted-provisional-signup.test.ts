import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  let deploymentMode: 'hosted' | 'self_hosted' = 'hosted';
  return {
    execute: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    get deploymentMode() {
      return deploymentMode;
    },
    set deploymentMode(value: 'hosted' | 'self_hosted') {
      deploymentMode = value;
    },
  };
});

vi.mock('../../src/lib/config.js', () => ({
  env: new Proxy(
    {},
    {
      get: (_target, property) =>
        property === 'PYLVA_DEPLOYMENT_MODE' ? mocks.deploymentMode : undefined,
    },
  ),
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    child: () => ({
      error: mocks.error,
      warn: mocks.warn,
    }),
  },
}));

const { assertHostedProvisionalSignupEnabledTx } = await import(
  '../../src/lib/auth/hosted-provisional-signup.js'
);

describe('hosted provisional signup rollout control', () => {
  beforeEach(() => {
    mocks.deploymentMode = 'hosted';
    mocks.execute.mockReset();
    mocks.error.mockReset();
    mocks.warn.mockReset();
  });

  it('allows hosted personal provisional creation only for the enabled singleton', async () => {
    mocks.execute.mockResolvedValueOnce([{ enabled: true }]);

    await expect(
      assertHostedProvisionalSignupEnabledTx({
        execute: mocks.execute,
      } as never),
    ).resolves.toBeUndefined();

    expect(mocks.execute).toHaveBeenCalledOnce();
  });

  it('accepts the wrapped row shape returned by supported database adapters', async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [{ enabled: true }] });

    await expect(
      assertHostedProvisionalSignupEnabledTx({
        execute: mocks.execute,
      } as never),
    ).resolves.toBeUndefined();
  });

  it.each([
    ['disabled', [{ enabled: false }]],
    ['missing', []],
    ['duplicate', [{ enabled: true }, { enabled: true }]],
    ['malformed', [{ enabled: 'true' }]],
  ])('fails closed when the singleton is %s', async (_label, rows) => {
    mocks.execute.mockResolvedValueOnce(rows);

    await expect(
      assertHostedProvisionalSignupEnabledTx({
        execute: mocks.execute,
      } as never),
    ).rejects.toMatchObject({
      name: 'HostedProvisionalSignupDisabledError',
      reason: 'control_missing_or_disabled',
    });
  });

  it('fails closed when the control query fails', async () => {
    mocks.execute.mockRejectedValueOnce(new Error('relation unavailable'));

    await expect(
      assertHostedProvisionalSignupEnabledTx({
        execute: mocks.execute,
      } as never),
    ).rejects.toMatchObject({
      name: 'HostedProvisionalSignupDisabledError',
      reason: 'control_lookup_failed',
    });
    expect(mocks.error).toHaveBeenCalledOnce();
  });

  it('does not query the hosted-only control for self-hosted creation', async () => {
    mocks.deploymentMode = 'self_hosted';

    await expect(
      assertHostedProvisionalSignupEnabledTx({
        execute: mocks.execute,
      } as never),
    ).resolves.toBeUndefined();
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
