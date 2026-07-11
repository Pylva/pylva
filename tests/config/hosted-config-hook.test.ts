// The hosted-overlay routing hook: the assembled production build overlays a
// root-level hosted.next.config.mjs; the public/self-host build has none. The
// absent-file path (arrays unchanged) is locked by next-config.test.ts, which
// imports the real config with no hosted file present; this suite pins the
// merge semantics the assembled build relies on.

import { describe, expect, it } from 'vitest';
import { mergeHostedRouting } from '../../next.config.mjs';

describe('mergeHostedRouting', () => {
  it('yields empty extensions when no hosted config exists (public/self-host)', () => {
    for (const absent of [null, undefined]) {
      expect(mergeHostedRouting(absent)).toEqual({
        headers: [],
        redirects: [],
        beforeFiles: [],
        afterFiles: [],
        fallback: [],
      });
    }
  });

  it('passes hosted routing through verbatim', () => {
    const hosted = {
      headers: [{ source: '/llms.txt', headers: [{ key: 'Cache-Control', value: 'public' }] }],
      redirects: [
        { source: '/docs/:path*', destination: 'https://docs.pylva.com/:path*', permanent: true },
      ],
      rewrites: {
        beforeFiles: [{ source: '/pricing.md', destination: '/md/pricing' }],
        afterFiles: [{ source: '/.well-known/:path*', destination: '/well-known/:path*' }],
      },
    };

    expect(mergeHostedRouting(hosted)).toEqual({
      headers: hosted.headers,
      redirects: hosted.redirects,
      beforeFiles: hosted.rewrites.beforeFiles,
      afterFiles: hosted.rewrites.afterFiles,
      fallback: [],
    });
  });

  it('tolerates partial hosted configs', () => {
    const merged = mergeHostedRouting({ headers: [{ source: '/x', headers: [] }] });
    expect(merged.headers).toHaveLength(1);
    expect(merged.redirects).toEqual([]);
    expect(merged.beforeFiles).toEqual([]);
    expect(merged.afterFiles).toEqual([]);
    expect(merged.fallback).toEqual([]);
  });
});
