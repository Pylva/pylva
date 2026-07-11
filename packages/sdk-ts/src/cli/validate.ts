#!/usr/bin/env node
// B3-T4a — `pylva validate` CLI entrypoint.
// Uses node:util.parseArgs — no external CLI framework dependency.

import { parseArgs } from 'node:util';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { walkManifests, type ManifestHit } from './scanner.js';
import { loadApprovedSources, runCiCheck, type Detection } from './ci-check.js';
import { runApprove } from './approve.js';
import { KNOWN_APIS, type KnownApis } from './known-apis.js';

function detect(hits: ManifestHit[], known: KnownApis): Detection[] {
  const out: Detection[] = [];
  for (const hit of hits) {
    for (const pkg of hit.dependencies) {
      const llm = known.llm_providers[pkg];
      if (llm) {
        out.push({
          package: pkg,
          manifest: hit.manifest,
          kind: 'llm_provider',
          display_name: llm.display_name,
          slug: llm.slug,
        });
        continue;
      }
      const nonLlm = known.non_llm_suggestions[pkg];
      if (nonLlm) {
        out.push({
          package: pkg,
          manifest: hit.manifest,
          kind: 'non_llm_suggested',
          display_name: nonLlm.display_name,
          slug: nonLlm.slug,
          suggested_metric: nonLlm.suggested_metric,
        });
      }
    }
  }
  // De-dup by slug — a monorepo may list openai in multiple manifests.
  const bySlug = new Map<string, Detection>();
  for (const d of out) if (!bySlug.has(d.slug)) bySlug.set(d.slug, d);
  return Array.from(bySlug.values());
}

function red(s: string): string {
  return `\x1b[31m${s}\x1b[0m`;
}
function green(s: string): string {
  return `\x1b[32m${s}\x1b[0m`;
}
function yellow(s: string): string {
  return `\x1b[33m${s}\x1b[0m`;
}
function bold(s: string): string {
  return `\x1b[1m${s}\x1b[0m`;
}

function renderTable(detections: Detection[]): string {
  if (detections.length === 0)
    return yellow('No LLM or known non-LLM cost sources detected in this tree.');
  const lines = [bold('Cost Source Checklist:')];
  for (const d of detections) {
    const badge = d.kind === 'llm_provider' ? green('LLM') : yellow('NON-LLM');
    lines.push(`  ${badge}  ${bold(d.display_name)}  (${d.package})  -> slug: ${d.slug}`);
  }
  return lines.join('\n');
}

const VALIDATE_OPTIONS = {
  json: { type: 'boolean', default: false },
  ci: { type: 'boolean', default: false },
  approve: { type: 'boolean', default: false },
  include: { type: 'string', multiple: true },
  exclude: { type: 'string', multiple: true },
  help: { type: 'boolean', short: 'h', default: false },
} as const;

export function normalizeValidateArgs(args: readonly string[]): string[] {
  if (args[0] === 'validate') return [...args.slice(1)];
  return [...args];
}

export function parseValidateArgs(args: readonly string[] = process.argv.slice(2)) {
  return parseArgs({
    args: normalizeValidateArgs(args),
    options: VALIDATE_OPTIONS,
    allowPositionals: false,
  });
}

async function main(): Promise<void> {
  const { values } = parseValidateArgs();

  if (values.help) {
    console.log(`pylva validate — scan dependency manifests for cost sources

Usage:
  npx pylva validate [--json] [--ci] [--approve] [--include GLOB] [--exclude GLOB]

Options:
  --json              Emit JSON instead of a colorized table (for CI parsing).
  --ci                Compare against .pylva/approved-sources.json. Exit 1 if a new
                      source is detected.
  --approve           Interactive: declare manual non-LLM sources and POST them to
                      /api/v1/cost-sources using PYLVA_API_KEY (your Pylva API key;
                      legacy PYLVA_CLI_KEY is still honored).
  --include GLOB      Only scan manifest paths matching GLOB (repeatable). Supports *.
  --exclude GLOB      Skip manifest paths matching GLOB (repeatable).
  -h, --help          Show this help.
`);
    return;
  }

  const root = process.cwd();
  const hits = await walkManifests(root, {
    include: values.include as string[] | undefined,
    exclude: values.exclude as string[] | undefined,
  });
  const detections = detect(hits, KNOWN_APIS);

  if (values.ci) {
    const approved = await loadApprovedSources(root);
    const result = runCiCheck(detections, approved);
    if (values.json) {
      console.log(JSON.stringify({ detections, approved, missing: result.missing }, null, 2));
    } else if (result.exitCode === 0) {
      console.log(green('Pylva: all detected cost sources are approved.'));
    } else {
      console.log(red(`Pylva: ${result.missing.length} uninstrumented cost source(s):`));
      for (const m of result.missing)
        console.log(`  - ${m.display_name} (${m.package})  slug=${m.slug}`);
      console.log(`\nRun \`npx pylva validate --approve\` to declare them.`);
    }
    process.exit(result.exitCode);
  }

  if (values.approve) {
    const result = await runApprove(detections, { cwd: root });
    if (values.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const d = result.declared.length;
      const s = result.skipped.length;
      console.log(green(`Declared ${d} source(s). Skipped ${s}.`));
      console.log('Wrote .pylva/approved-sources.json — commit this to your repo.');
    }
    return;
  }

  if (values.json) {
    console.log(JSON.stringify({ detections }, null, 2));
    return;
  }

  console.log(renderTable(detections));
}

function isCliEntrypoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const entryUrls = [pathToFileURL(entry).href];
  try {
    entryUrls.push(pathToFileURL(realpathSync(entry)).href);
  } catch {
    // Ignore missing/non-filesystem argv[1] values.
  }
  return entryUrls.includes(import.meta.url);
}

if (isCliEntrypoint()) {
  main().catch((err: unknown) => {
    console.error('pylva validate failed:', err instanceof Error ? err.message : err);
    process.exit(2);
  });
}
