// B3-T4a — `pylva validate --approve` interactive flow.
//
// Walks the builder through declaring non-LLM cost sources: prompts for
// display_name / metric / unit / pricing template, POSTs each declaration to
// `POST /api/v1/cost-sources` using the builder's API key, and persists the
// result to `.pylva/approved-sources.json` so CI (`--ci`) can verify the
// set on subsequent runs.
//
// Auto-registered LLM providers are skipped — the ingest route creates those
// automatically (D29). Only builder-authored non-LLM sources flow through here.
//
// Design notes (B3 spec):
//   D27 (superseded) — the separate pv_cli_* key type is retired: one
//        universal key covers imports. PYLVA_API_KEY is preferred;
//        PYLVA_CLI_KEY and existing pv_cli_* keys keep working.
//   D28  — display_name preserves casing, slug is lowercase-hyphenated.
//   D33  — metric names are free text, slugified on both sides.
//   D34  — pricing_tiers JSONB `[{from, to, price}]`; null means flat price.
//   D35  — predefined templates: flat / volume-discount / free-tier / advanced.
//   D38  — approved-sources.json lives under `.pylva/` in-repo.

import { promises as fs } from 'node:fs';
import * as readline from 'node:readline/promises';
import path from 'node:path';
import {
  CostSourceType,
  type CostSourceType as CostSourceTypeT,
  type PricingTier,
} from '@pylva/shared';
import { slugify } from './slugify.js';
import type { ApprovedSource, Detection } from './ci-check.js';

interface DeclarationPayload {
  display_name: string;
  slug: string;
  source_type: CostSourceTypeT;
  metric?: string;
  unit?: string;
  price_per_unit?: number;
  pricing_tiers?: PricingTier[];
}

export interface ApproveOptions {
  cwd?: string;
  endpoint?: string;
  cliKey?: string;
  // Injected for tests — default uses node:readline/promises + process.stdin/stdout.
  prompt?: (question: string) => Promise<string>;
  // Injected for tests — default uses globalThis.fetch.
  fetchImpl?: typeof fetch;
  // Injected for tests — skips the `!stdin.isTTY` guard so piped stdin works.
  allowNonTty?: boolean;
}

export interface ApproveResult {
  declared: ApprovedSource[];
  skipped: Detection[];
  cancelled: boolean;
}

const TEMPLATES = [
  { label: 'Flat rate', key: 'flat' },
  { label: 'Volume discount (3 tiers)', key: 'volume' },
  { label: 'Free tier + paid', key: 'free_tier' },
  { label: 'Advanced (custom tiers, max 5)', key: 'advanced' },
] as const;
type TemplateKey = (typeof TEMPLATES)[number]['key'];

export async function runApprove(
  detections: Detection[],
  opts: ApproveOptions = {},
): Promise<ApproveResult> {
  const cwd = opts.cwd ?? process.cwd();
  const endpoint =
    opts.endpoint ?? process.env['PYLVA_ENDPOINT'] ?? 'https://api.pylva.com';
  // One universal key: PYLVA_API_KEY is preferred; PYLVA_CLI_KEY remains as a
  // legacy fallback so existing CI configurations keep working.
  const cliKey =
    opts.cliKey ?? process.env['PYLVA_API_KEY'] ?? process.env['PYLVA_CLI_KEY'] ?? '';

  if (!/^pv_(?:live|cli)_[a-f0-9]{8}_[a-f0-9]{32}$/.test(cliKey)) {
    throw new Error(
      'approve requires PYLVA_API_KEY set to your Pylva API key ' +
        '(pv_live_* or legacy pv_cli_*). Create one from dashboard Settings → API keys.',
    );
  }
  if (!opts.allowNonTty && opts.prompt === undefined && !process.stdin.isTTY) {
    throw new Error('approve requires an interactive terminal (stdin is not a TTY).');
  }

  const rl =
    opts.prompt === undefined
      ? readline.createInterface({ input: process.stdin, output: process.stdout })
      : null;
  const ask = opts.prompt ?? (async (q: string) => (await rl!.question(q)).trim());

  try {
    const existing = await readApprovedFile(cwd);
    const existingBySlug = new Map(existing.map((e) => [e.slug, e]));

    // Only non-LLM detections require interactive declaration. LLM providers
    // auto-register via ingest; we record them in the approvals file so --ci
    // has a complete picture.
    const interactive = detections.filter((d) => d.kind === 'non_llm_suggested');
    const llmAuto = detections.filter((d) => d.kind === 'llm_provider');

    const declared: ApprovedSource[] = [];
    const skipped: Detection[] = [];

    for (const det of interactive) {
      if (existingBySlug.has(det.slug)) {
        skipped.push(det);
        continue;
      }
      const accept = await askYesNo(
        ask,
        `Declare ${det.display_name} (${det.package})? [Y/n] `,
        true,
      );
      if (!accept) {
        skipped.push(det);
        continue;
      }
      const payload = await collectDeclaration(det, ask);
      const saved = await postDeclaration(payload, { endpoint, cliKey, fetchImpl: opts.fetchImpl });
      declared.push(saved);
      existingBySlug.set(saved.slug, saved);
    }

    // LLM providers — record for --ci completeness, no interactive prompt.
    for (const det of llmAuto) {
      if (existingBySlug.has(det.slug)) continue;
      const entry: ApprovedSource = {
        slug: det.slug,
        display_name: det.display_name,
        source_type: CostSourceType.LLM_PROVIDER,
      };
      declared.push(entry);
      existingBySlug.set(entry.slug, entry);
    }

    await writeApprovedFile(cwd, Array.from(existingBySlug.values()));
    return { declared, skipped, cancelled: false };
  } finally {
    rl?.close();
  }
}

async function collectDeclaration(
  det: Detection,
  ask: (q: string) => Promise<string>,
): Promise<DeclarationPayload> {
  const displayNameRaw = (await ask(`Display name [${det.display_name}]: `)) || det.display_name;
  const display_name = displayNameRaw.trim();
  const slug = slugify(display_name) || det.slug;

  const metricRaw =
    (await ask(`Metric (e.g. characters, requests) [${det.suggested_metric ?? ''}]: `)) ||
    det.suggested_metric ||
    '';
  const metric = metricRaw ? slugify(metricRaw) : undefined;
  const unit = (await ask('Unit (singular, e.g. "character"): ')) || undefined;

  const templateKey = await promptTemplate(ask);
  const pricing = await promptPricing(templateKey, ask);

  return {
    display_name,
    slug,
    source_type: CostSourceType.NON_LLM_MANUAL,
    metric,
    unit,
    ...pricing,
  };
}

async function promptTemplate(ask: (q: string) => Promise<string>): Promise<TemplateKey> {
  while (true) {
    const lines = ['Pricing template:'];
    TEMPLATES.forEach((t, i) => lines.push(`  ${i + 1}) ${t.label}`));
    lines.push('Choose [1-4]: ');
    const raw = (await ask(lines.join('\n'))).trim();
    const idx = Number.parseInt(raw, 10) - 1;
    if (idx >= 0 && idx < TEMPLATES.length) return TEMPLATES[idx]!.key;
  }
}

async function promptPricing(
  key: TemplateKey,
  ask: (q: string) => Promise<string>,
): Promise<Pick<DeclarationPayload, 'price_per_unit' | 'pricing_tiers'>> {
  if (key === 'flat') {
    const price = await askNumber(ask, 'Price per unit (USD): ');
    return { price_per_unit: price };
  }
  if (key === 'volume') {
    // Fixed 3-tier volume discount. Enforce t1 < t2 + non-negative bounds so
    // the emitted pricing_tiers stays monotonic (server trusts our shape).
    const t1 = await askNumber(ask, 'Tier 1 upper bound (units): ', { min: 1 });
    const p1 = await askNumber(ask, 'Tier 1 price per unit (USD): ', { min: 0 });
    const t2 = await askNumber(ask, 'Tier 2 upper bound (units): ', { min: t1 + 1 });
    const p2 = await askNumber(ask, 'Tier 2 price per unit (USD): ', { min: 0 });
    const p3 = await askNumber(ask, 'Tier 3 price per unit (USD, above tier 2): ', { min: 0 });
    return {
      pricing_tiers: [
        { from: 0, to: t1, price: p1 },
        { from: t1 + 1, to: t2, price: p2 },
        { from: t2 + 1, to: null, price: p3 },
      ],
    };
  }
  if (key === 'free_tier') {
    const free = await askNumber(ask, 'Free tier upper bound (units): ', { min: 1 });
    const paid = await askNumber(ask, 'Price per unit above free tier (USD): ', { min: 0 });
    return {
      pricing_tiers: [
        { from: 0, to: free, price: 0 },
        { from: free + 1, to: null, price: paid },
      ],
    };
  }
  // advanced — up to 5 tiers, builder-defined.
  const tiers: PricingTier[] = [];
  for (let i = 0; i < 5; i++) {
    const cont = i === 0 ? true : await askYesNo(ask, `Add tier ${i + 1}? [Y/n] `, true);
    if (!cont) break;
    const from = await askNumber(ask, `Tier ${i + 1} from (units): `);
    const toRaw = (await ask(`Tier ${i + 1} to (units, blank for open-ended): `)).trim();
    const to = toRaw === '' ? null : Number.parseInt(toRaw, 10);
    const price = await askNumber(ask, `Tier ${i + 1} price per unit (USD): `);
    tiers.push({ from, to: Number.isFinite(to ?? Number.NaN) ? (to as number) : null, price });
  }
  return { pricing_tiers: tiers };
}

async function askNumber(
  ask: (q: string) => Promise<string>,
  q: string,
  bounds: { min?: number; max?: number } = {},
): Promise<number> {
  const { min, max } = bounds;
  while (true) {
    const raw = (await ask(q)).trim();
    const n = Number.parseFloat(raw);
    if (!Number.isFinite(n)) continue;
    if (min !== undefined && n < min) continue;
    if (max !== undefined && n > max) continue;
    return n;
  }
}

async function askYesNo(
  ask: (q: string) => Promise<string>,
  q: string,
  defaultYes: boolean,
): Promise<boolean> {
  const raw = (await ask(q)).trim().toLowerCase();
  if (raw === '') return defaultYes;
  return raw.startsWith('y');
}

async function postDeclaration(
  payload: DeclarationPayload,
  ctx: { endpoint: string; cliKey: string; fetchImpl?: typeof fetch },
): Promise<ApprovedSource> {
  const fetchFn = ctx.fetchImpl ?? globalThis.fetch;
  const res = await fetchFn(`${ctx.endpoint}/api/v1/cost-sources`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${ctx.cliKey}`,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`cost-sources POST failed (${res.status}): ${text}`);
  }
  // Regardless of how the server echoes the row, we canonicalize what we keep
  // in .pylva/approved-sources.json to the fields --ci cares about.
  return {
    slug: payload.slug,
    display_name: payload.display_name,
    source_type: payload.source_type,
    metric: payload.metric,
    unit: payload.unit,
  };
}

async function readApprovedFile(cwd: string): Promise<ApprovedSource[]> {
  try {
    const raw = await fs.readFile(path.join(cwd, '.pylva', 'approved-sources.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ApprovedSource[]) : [];
  } catch {
    return [];
  }
}

async function writeApprovedFile(cwd: string, sources: ApprovedSource[]): Promise<void> {
  const dir = path.join(cwd, '.pylva');
  await fs.mkdir(dir, { recursive: true });
  // Stable ordering so diffs stay reviewable in CI.
  const sorted = [...sources].sort((a, b) => a.slug.localeCompare(b.slug));
  await fs.writeFile(
    path.join(dir, 'approved-sources.json'),
    JSON.stringify(sorted, null, 2) + '\n',
    'utf8',
  );
}
