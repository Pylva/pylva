// Regression for the loadPeer eval probe: the previous implementation read
// import.meta through an indirect eval, which throws SyntaxError in both
// module systems — loadPeer returned undefined for EVERY specifier at
// runtime (auto-patch silently instrumented nothing) while every wrapper
// test mocked loadPeer and stayed green. This file deliberately does NOT
// mock it.

import { describe, it, expect } from 'vitest';
import { loadPeer } from '../src/wrappers/_load.js';

describe('loadPeer (unmocked)', () => {
  it('resolves an installed CJS-requirable package', () => {
    // openai is a devDependency of this package precisely so wrapper tests
    // can exercise real resolution. loadPeer is require-based, so the target
    // must ship a CJS build (openai does).
    const mod = loadPeer<Record<string, unknown>>('openai');
    expect(mod).toBeDefined();
  });

  it('returns undefined for a missing package without throwing (R1)', () => {
    expect(loadPeer('definitely-not-a-real-package-amx')).toBeUndefined();
  });
});
