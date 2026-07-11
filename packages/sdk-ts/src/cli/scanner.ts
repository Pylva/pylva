// B3-T4a — Dependency-file scanner for `pylva validate`.
// Walks the directory tree from CWD, reads package.json / requirements.txt /
// pyproject.toml, and returns the union of detected dependency names. Skips
// node_modules, .venv, dist, .next, and other standard build/vendor dirs.
//
// Optional `include` / `exclude` options filter *manifest paths* using simple
// `*` glob semantics (e.g. `packages/*/package.json`). No `micromatch` dep —
// project rule: no new dependencies without maintainer approval.

import { promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';

const SKIP_DIRS = new Set([
  'node_modules',
  '.venv',
  'venv',
  '.git',
  'dist',
  'build',
  '.next',
  '.turbo',
  '__pycache__',
  'target',
  'coverage',
]);

export interface ManifestHit {
  manifest: string; // absolute path
  dependencies: string[]; // package names
}

export interface WalkOptions {
  include?: string[]; // glob patterns that manifest paths must match (any-of)
  exclude?: string[]; // glob patterns that manifest paths must NOT match
}

export async function walkManifests(root: string, opts: WalkOptions = {}): Promise<ManifestHit[]> {
  const hits: ManifestHit[] = [];
  await walk(root, hits);
  return applyFilters(hits, root, opts);
}

function applyFilters(hits: ManifestHit[], root: string, opts: WalkOptions): ManifestHit[] {
  const include = (opts.include ?? []).map(compileGlob);
  const exclude = (opts.exclude ?? []).map(compileGlob);
  if (include.length === 0 && exclude.length === 0) return hits;
  return hits.filter((hit) => {
    const rel = path.relative(root, hit.manifest).split(path.sep).join('/');
    if (include.length > 0 && !include.some((re) => re.test(rel))) return false;
    if (exclude.some((re) => re.test(rel))) return false;
    return true;
  });
}

// Compile a `*`-glob to a regex. `*` matches within a path segment (no `/`);
// `**` matches across segments. Sufficient for monorepo scoping without
// pulling in micromatch. Compiled once per invocation, not per manifest.
function compileGlob(pattern: string): RegExp {
  const body = pattern
    .split('/')
    .map((seg) => {
      if (seg === '**') return '.*';
      return seg
        .split('*')
        .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('[^/]*');
    })
    .join('/');
  return new RegExp(`^${body}$`);
}

async function walk(dir: string, out: ManifestHit[]): Promise<void> {
  let entries: Dirent[];
  try {
    // Node's overload resolution lands on Dirent<Buffer> under certain
    // @types/node + TS combos when `encoding` is omitted. Pin the return type
    // explicitly so entry.name is always a string.
    entries = (await fs.readdir(dir, { withFileTypes: true, encoding: 'utf8' })) as Dirent[];
  } catch {
    return;
  }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      await walk(p, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name === 'package.json') {
      const deps = await readPackageJson(p);
      if (deps.length > 0) out.push({ manifest: p, dependencies: deps });
    } else if (entry.name === 'requirements.txt') {
      const deps = await readRequirementsTxt(p);
      if (deps.length > 0) out.push({ manifest: p, dependencies: deps });
    } else if (entry.name === 'pyproject.toml') {
      const deps = await readPyProjectToml(p);
      if (deps.length > 0) out.push({ manifest: p, dependencies: deps });
    }
  }
}

async function readPackageJson(file: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    return Array.from(
      new Set([
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.devDependencies ?? {}),
        ...Object.keys(pkg.peerDependencies ?? {}),
      ]),
    );
  } catch {
    return [];
  }
}

async function readRequirementsTxt(file: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return raw
      .split('\n')
      .map((line) => line.split('#', 1)[0]!.trim())
      .filter(Boolean)
      .map((line) => line.split(/[<>=!~\s;]/)[0]!.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function readPyProjectToml(file: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    // Lightweight scan — we only need package names, not semver. Matches
    // `name = "pkg"` inside dependency arrays. No full TOML parser dependency.
    const deps: string[] = [];
    const dependencyArrayRe = /dependencies\s*=\s*\[([\s\S]*?)\]/g;
    for (const m of raw.matchAll(dependencyArrayRe)) {
      const body = m[1] ?? '';
      for (const strMatch of body.matchAll(/["']([^"']+)["']/g)) {
        const spec = strMatch[1]!;
        const pkg = spec.split(/[<>=!~\s;]/)[0]!.trim();
        if (pkg) deps.push(pkg);
      }
    }
    return Array.from(new Set(deps));
  } catch {
    return [];
  }
}
