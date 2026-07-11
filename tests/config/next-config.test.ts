import { describe, expect, it } from 'vitest';
import nextConfig from '../../next.config.mjs';

type Rule = { source: string };
type HeaderRule = {
  source: string;
  headers: Array<{ key: string; value: string }>;
};

const HSTS_HEADER = 'Strict-Transport-Security';
const HSTS_VALUE = 'max-age=31536000';

async function allSources(): Promise<string[]> {
  const headers = nextConfig.headers ? ((await nextConfig.headers()) as Rule[]) : [];
  const redirects = nextConfig.redirects ? ((await nextConfig.redirects()) as Rule[]) : [];
  const rewrites = nextConfig.rewrites
    ? ((await nextConfig.rewrites()) as {
        beforeFiles: Rule[];
        afterFiles: Rule[];
        fallback: Rule[];
      })
    : { beforeFiles: [], afterFiles: [], fallback: [] };

  return [
    ...headers,
    ...redirects,
    ...rewrites.beforeFiles,
    ...rewrites.afterFiles,
    ...rewrites.fallback,
  ].map((rule) => rule.source);
}

describe('next.config public self-host routing', () => {
  it('never applies config-level routing to private app or API surfaces', async () => {
    for (const source of await allSources()) {
      expect(source).not.toBe('/:path*');
      expect(source).not.toMatch(/^\/portal/);
      expect(source).not.toMatch(/^\/api/);
      expect(source).not.toMatch(/^\/o(\/|$)/);
    }
  });

  it('keeps config-level headers scoped to the product login surface', async () => {
    const headers = (await nextConfig.headers!()) as HeaderRule[];

    expect(headers.map((rule) => rule.source)).toEqual(['/login']);
    const login = headers[0]!;
    expect(login.headers.find((header) => header.key === HSTS_HEADER)?.value).toBe(HSTS_VALUE);
    expect(login.headers.find((header) => header.key === 'Content-Security-Policy')?.value).toBe(
      "frame-ancestors 'self'",
    );
    expect(login.headers.map((header) => header.key)).not.toContain('Link');
  });

  it('does not keep hosted website markdown rewrites or docs redirects in the public repo', async () => {
    const redirects = (await nextConfig.redirects!()) as Rule[];
    const rewrites = (await nextConfig.rewrites!()) as {
      beforeFiles: Rule[];
      afterFiles: Rule[];
      fallback: Rule[];
    };

    expect(redirects).toEqual([]);
    expect(rewrites).toEqual({ beforeFiles: [], afterFiles: [], fallback: [] });
  });
});
