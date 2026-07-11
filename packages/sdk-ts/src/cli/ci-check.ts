// B3-T4a — `pylva validate --ci` logic.
//
// Compares the live dependency-file scan against `.pylva/approved-sources.json`
// (committed alongside the repo per D38) and returns an exit code:
//   0 — every detected source is already approved.
//   1 — at least one new uninstrumented source appeared since the last --approve.
//
// Pure function — validate.ts is responsible for process.exit() and colorized
// output. Keeping this module side-effect free makes it trivially unit-testable.

import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface Detection {
  package: string;
  manifest: string;
  kind: 'llm_provider' | 'non_llm_suggested';
  display_name: string;
  slug: string;
  suggested_metric?: string;
}

export interface ApprovedSource {
  slug: string;
  display_name?: string;
  source_type?: string;
  metric?: string;
  unit?: string;
}

export interface CiCheckResult {
  exitCode: 0 | 1;
  missing: Detection[];
  approved: ApprovedSource[];
}

export async function loadApprovedSources(cwd: string): Promise<ApprovedSource[]> {
  try {
    const raw = await fs.readFile(path.join(cwd, '.pylva', 'approved-sources.json'), 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as ApprovedSource[];
  } catch {
    return [];
  }
}

export function runCiCheck(detections: Detection[], approved: ApprovedSource[]): CiCheckResult {
  const approvedSlugs = new Set(approved.map((s) => s.slug));
  const missing = detections.filter((d) => !approvedSlugs.has(d.slug));
  return { exitCode: missing.length === 0 ? 0 : 1, missing, approved };
}
