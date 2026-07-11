import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

interface AppBuildManifest {
  pages: Record<string, string[]>;
}

interface RouteBudget {
  route: string;
  maxFiles: number;
  maxRawKiB: number;
}

const repoRoot = process.cwd();
const manifestPath = path.join(repoRoot, '.next', 'app-build-manifest.json');
const staticDir = path.join(repoRoot, '.next', 'static');

const budgets: RouteBudget[] = [
  { route: '/login/page', maxFiles: 6, maxRawKiB: 650 },
  { route: '/portal/page', maxFiles: 5, maxRawKiB: 625 },
  { route: '/o/[slug]/layout', maxFiles: 5, maxRawKiB: 625 },
  { route: '/o/[slug]/dashboard/page', maxFiles: 7, maxRawKiB: 650 },
  { route: '/o/[slug]/dashboard/settings/api-keys/page', maxFiles: 7, maxRawKiB: 650 },
  { route: '/o/[slug]/dashboard/rules/new/[type]/page', maxFiles: 6, maxRawKiB: 660 },
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

function routeRawKiB(files: string[]): number {
  const bytes = files.reduce((sum, file) => {
    const fullPath = path.join(repoRoot, '.next', file);
    return sum + (existsSync(fullPath) ? statSync(fullPath).size : 0);
  }, 0);
  return Math.ceil(bytes / 1024);
}

if (!existsSync(manifestPath)) {
  fail('missing .next/app-build-manifest.json; run pnpm build before pnpm perf:budget');
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as AppBuildManifest;
const staticFiles = walkFiles(staticDir);
const fontAssets = staticFiles.filter((file) => /\.(woff2?|ttf|otf)$/i.test(file));

if (fontAssets.length > 0) {
  fail(`unexpected font assets in .next/static: ${fontAssets.map((file) => path.relative(repoRoot, file)).join(', ')}`);
}

for (const budget of budgets) {
  const files = manifest.pages[budget.route];
  if (!files) fail(`missing route in app build manifest: ${budget.route}`);

  const rawKiB = routeRawKiB(files);
  const extraChunkFiles = files.filter((file) =>
    file.startsWith('static/chunks/') &&
    !file.startsWith('static/chunks/app/') &&
    !file.includes('/webpack-') &&
    !file.includes('/main-app-') &&
    !/static\/chunks\/[a-f0-9]+-/.test(file),
  );

  if (files.length > budget.maxFiles) {
    fail(`${budget.route} loaded ${files.length} files; budget is ${budget.maxFiles}. Files: ${files.join(', ')}`);
  }

  if (rawKiB > budget.maxRawKiB) {
    fail(`${budget.route} is ${rawKiB} KiB raw; budget is ${budget.maxRawKiB} KiB`);
  }

  if (extraChunkFiles.length > 0) {
    fail(`${budget.route} has avoidable extra chunks: ${extraChunkFiles.join(', ')}`);
  }

  console.log(`${budget.route}: ${rawKiB} KiB raw across ${files.length} files`);
}

console.log('performance budget passed');
