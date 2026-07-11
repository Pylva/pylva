import { withSentryConfig } from '@sentry/nextjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SECURITY_HEADERS = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Strict-Transport-Security', value: 'max-age=31536000' },
];

// Hosted-overlay routing hook. The hosted production build (assembled in
// pylva-internal from public core + internal overlay) ships a root-level
// `hosted.next.config.mjs` restoring public-website routing: marketing/AEO
// headers, markdown content negotiation, `/.well-known` handling, and docs
// redirects. That file must never exist in this repo or a self-host checkout
// (tests/repo-boundary/hosted-website-source.test.ts enforces it), so the
// import fails here and every hosted extension below is a no-op.
export function mergeHostedRouting(hosted) {
  return {
    headers: hosted?.headers ?? [],
    redirects: hosted?.redirects ?? [],
    beforeFiles: hosted?.rewrites?.beforeFiles ?? [],
    afterFiles: hosted?.rewrites?.afterFiles ?? [],
    fallback: hosted?.rewrites?.fallback ?? [],
  };
}

let hostedConfig = null;
try {
  hostedConfig = (await import(new URL('./hosted.next.config.mjs', import.meta.url).href)).default;
} catch {
  hostedConfig = null;
}
const hostedRouting = mergeHostedRouting(hostedConfig);

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  outputFileTracingRoot: __dirname,
  serverExternalPackages: ['argon2', 'redis'],
  transpilePackages: ['@pylva/shared'],
  experimental: {
    serverActions: {
      bodySizeLimit: '2mb',
    },
    staleTimes: {
      dynamic: 30,
    },
  },
  async headers() {
    return [
      ...hostedRouting.headers,
      {
        source: '/login',
        headers: [
          ...SECURITY_HEADERS,
          { key: 'Content-Security-Policy', value: "frame-ancestors 'self'" },
        ],
      },
    ];
  },
  async redirects() {
    return [...hostedRouting.redirects];
  },
  async rewrites() {
    return {
      beforeFiles: [...hostedRouting.beforeFiles],
      afterFiles: [...hostedRouting.afterFiles],
      fallback: [...hostedRouting.fallback],
    };
  },
  webpack: (config, { isServer, nextRuntime }) => {
    config.resolve = config.resolve ?? {};
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js', '.jsx'],
      '.mjs': ['.mts', '.mjs'],
    };
    if (
      process.env.PYLVA_SERVERLESS_NEXT_DISABLE_SERVER_MINIFY === 'true' &&
      (isServer || nextRuntime === 'edge')
    ) {
      config.optimization = config.optimization ?? {};
      config.optimization.minimize = false;
    }
    return config;
  },
};

const hasSentryUploadConfig = Boolean(
  process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT,
);

export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.CI,
  telemetry: false,
  widenClientFileUpload: true,
  webpack: {
    treeshake: {
      removeDebugLogging: true,
    },
  },
  sourcemaps: {
    disable: !hasSentryUploadConfig,
  },
  release: {
    name: process.env.SENTRY_RELEASE,
  },
});
