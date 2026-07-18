import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface AppBuildManifest {
  pages: Record<string, string[]>;
}

export interface RouteBudget {
  route: string;
  maxFiles: number;
  maxRawKiB: number;
}

// @sentry/nextjs 10.65 split its 481-byte semantic-attributes module into a
// separate chunk shared by every app route. Exact CI and local Node 20 builds
// both show one additional request without a login- or route-owned code change.
const SENTRY_SHARED_CHUNK_FILE_ALLOWANCE = 1;

export const routeBudgets: readonly RouteBudget[] = [
  { route: '/login/page', maxFiles: 6 + SENTRY_SHARED_CHUNK_FILE_ALLOWANCE, maxRawKiB: 650 },
  { route: '/portal/page', maxFiles: 5 + SENTRY_SHARED_CHUNK_FILE_ALLOWANCE, maxRawKiB: 625 },
  { route: '/o/[slug]/layout', maxFiles: 5 + SENTRY_SHARED_CHUNK_FILE_ALLOWANCE, maxRawKiB: 625 },
  {
    route: '/o/[slug]/dashboard/page',
    maxFiles: 7 + SENTRY_SHARED_CHUNK_FILE_ALLOWANCE,
    maxRawKiB: 652,
  },
  {
    route: '/o/[slug]/dashboard/settings/api-keys/page',
    maxFiles: 7 + SENTRY_SHARED_CHUNK_FILE_ALLOWANCE,
    maxRawKiB: 653,
  },
  {
    route: '/o/[slug]/dashboard/rules/new/[type]/page',
    maxFiles: 6 + SENTRY_SHARED_CHUNK_FILE_ALLOWANCE,
    maxRawKiB: 660,
  },
];

function fail(message: string): never {
  console.error(`performance budget failed: ${message}`);
  process.exit(1);
}

function walkFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    return entry.isDirectory() ? walkFiles(fullPath) : [fullPath];
  });
}

function routeRawKiB(repoRoot: string, files: string[]): number {
  const bytes = files.reduce((sum, file) => {
    const fullPath = path.join(repoRoot, '.next', file);
    return sum + (existsSync(fullPath) ? statSync(fullPath).size : 0);
  }, 0);
  return Math.ceil(bytes / 1024);
}

export function routeBudgetViolation(
  budget: RouteBudget,
  files: readonly string[],
  rawKiB: number,
): string | undefined {
  const extraChunkFiles = files.filter(
    (file) =>
      file.startsWith('static/chunks/') &&
      !file.startsWith('static/chunks/app/') &&
      !file.includes('/webpack-') &&
      !file.includes('/main-app-') &&
      !/static\/chunks\/[a-f0-9]+-/.test(file),
  );

  if (files.length > budget.maxFiles) {
    return `${budget.route} loaded ${files.length} files; budget is ${budget.maxFiles}. Files: ${files.join(', ')}`;
  }

  if (rawKiB > budget.maxRawKiB) {
    return `${budget.route} is ${rawKiB} KiB raw; budget is ${budget.maxRawKiB} KiB`;
  }

  if (extraChunkFiles.length > 0) {
    return `${budget.route} has avoidable extra chunks: ${extraChunkFiles.join(', ')}`;
  }

  return undefined;
}

export function assertPerformanceBudget(repoRoot = process.cwd()): void {
  const manifestPath = path.join(repoRoot, '.next', 'app-build-manifest.json');
  const staticDir = path.join(repoRoot, '.next', 'static');
  if (!existsSync(manifestPath)) {
    fail('missing .next/app-build-manifest.json; run pnpm build before pnpm perf:budget');
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as AppBuildManifest;
  const staticFiles = walkFiles(staticDir);
  const fontAssets = staticFiles.filter((file) => /\.(woff2?|ttf|otf)$/i.test(file));

  if (fontAssets.length > 0) {
    fail(
      `unexpected font assets in .next/static: ${fontAssets.map((file) => path.relative(repoRoot, file)).join(', ')}`,
    );
  }

  for (const budget of routeBudgets) {
    const files = manifest.pages[budget.route];
    if (!files) fail(`missing route in app build manifest: ${budget.route}`);

    const rawKiB = routeRawKiB(repoRoot, files);
    const violation = routeBudgetViolation(budget, files, rawKiB);
    if (violation) fail(violation);

    console.log(`${budget.route}: ${rawKiB} KiB raw across ${files.length} files`);
  }

  console.log('performance budget passed');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assertPerformanceBudget();
}
