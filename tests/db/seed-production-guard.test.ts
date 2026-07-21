import { describe, expect, it } from 'vitest';
import { assertSafeSeedEnvironment } from '../../db/seed.js';

describe('database seed production guard', () => {
  it('refuses to run when NODE_ENV is production', () => {
    expect(() => assertSafeSeedEnvironment({ NODE_ENV: 'production' })).toThrow(
      'Refusing to seed a production database',
    );
  });

  it.each([undefined, 'development', 'test'])('allows NODE_ENV=%s', (nodeEnv) => {
    expect(() => assertSafeSeedEnvironment({ NODE_ENV: nodeEnv })).not.toThrow();
  });
});
