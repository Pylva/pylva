// CLI argument parsing coverage for the published `pylva` bin.

import { describe, expect, it } from 'vitest';
import { normalizeValidateArgs, parseValidateArgs } from '../../src/cli/validate.js';

describe('pylva validate CLI args', () => {
  it('accepts the documented validate subcommand before --help', () => {
    const parsed = parseValidateArgs(['validate', '--help']);

    expect(parsed.values.help).toBe(true);
  });

  it('accepts --help directly for the bin entrypoint', () => {
    const parsed = parseValidateArgs(['--help']);

    expect(parsed.values.help).toBe(true);
  });

  it('accepts the documented validate subcommand before --ci', () => {
    const parsed = parseValidateArgs(['validate', '--ci']);

    expect(parsed.values.ci).toBe(true);
  });

  it('keeps unknown positional arguments rejected', () => {
    expect(() => parseValidateArgs(['scan'])).toThrow(/Unexpected argument 'scan'/);
  });

  it('only strips validate when it is the leading subcommand', () => {
    expect(normalizeValidateArgs(['--include', 'validate'])).toEqual(['--include', 'validate']);
  });
});
