import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import {
  BudgetControlCapabilitiesResponseSchema,
  BudgetControlErrorResponseSchema,
  CanonicalPostProviderCostDecimalSchema,
  CommitUsageRequestSchema,
  CommitUsageResponseSchema,
  ExtendUsageRequestSchema,
  ExtendUsageResponseSchema,
  ReleaseUsageRequestSchema,
  ReleaseUsageResponseSchema,
  ReserveUsageRequestSchema,
  ReserveUsageResponseSchema,
} from '../src/core/control_schema.js';

const SCHEMA_KEYS = [
  'capabilities_response',
  'reservation_request',
  'reservation_response',
  'commit_request',
  'commit_response',
  'release_request',
  'release_response',
  'extend_request',
  'extend_response',
  'error_response',
] as const;

type SchemaKey = (typeof SCHEMA_KEYS)[number];
type SpecialNumberName = 'nan' | 'positive_infinity' | 'negative_infinity';
type SpecialStringName = 'lone_high_surrogate' | 'lone_low_surrogate';

interface ContractFixture {
  name: string;
  schema: SchemaKey;
  valid: boolean;
  value: unknown;
  expected_output?: unknown;
}

interface ContractCorpus {
  $schema_version: string;
  description: string;
  fixtures: ContractFixture[];
}

const schemas: Record<SchemaKey, v.GenericSchema> = {
  capabilities_response: BudgetControlCapabilitiesResponseSchema,
  reservation_request: ReserveUsageRequestSchema,
  reservation_response: ReserveUsageResponseSchema,
  commit_request: CommitUsageRequestSchema,
  commit_response: CommitUsageResponseSchema,
  release_request: ReleaseUsageRequestSchema,
  release_response: ReleaseUsageResponseSchema,
  extend_request: ExtendUsageRequestSchema,
  extend_response: ExtendUsageResponseSchema,
  error_response: BudgetControlErrorResponseSchema,
};

const corpus = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../tests/contracts/budget-control-contract.json', import.meta.url),
    ),
    'utf8',
  ),
) as ContractCorpus;

const specialNumbers: Record<SpecialNumberName, number> = {
  nan: Number.NaN,
  positive_infinity: Number.POSITIVE_INFINITY,
  negative_infinity: Number.NEGATIVE_INFINITY,
};

const specialStrings: Record<SpecialStringName, string> = {
  lone_high_surrogate: '\uD800',
  lone_low_surrogate: '\uDFFF',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function materializeSpecialValues(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(materializeSpecialValues);
  if (!isRecord(value)) return value;
  if (Object.keys(value).length === 1 && '$special_number' in value) {
    const name = value['$special_number'];
    if (typeof name !== 'string' || !(name in specialNumbers)) {
      throw new Error(`Unknown special-number sentinel: ${String(name)}`);
    }
    return specialNumbers[name as SpecialNumberName];
  }
  if (Object.keys(value).length === 1 && '$special_string' in value) {
    const name = value['$special_string'];
    if (typeof name !== 'string' || !(name in specialStrings)) {
      throw new Error(`Unknown special-string sentinel: ${String(name)}`);
    }
    return specialStrings[name as SpecialStringName];
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, materializeSpecialValues(item)]),
  );
}

function collectSpecialNumbers(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectSpecialNumbers(item, found);
    return found;
  }
  if (!isRecord(value)) return found;
  if (Object.keys(value).length === 1 && '$special_number' in value) {
    const name = value['$special_number'];
    if (typeof name === 'string') found.add(name);
    return found;
  }
  for (const item of Object.values(value)) collectSpecialNumbers(item, found);
  return found;
}

function collectSpecialStrings(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectSpecialStrings(item, found);
    return found;
  }
  if (!isRecord(value)) return found;
  if (Object.keys(value).length === 1 && '$special_string' in value) {
    const name = value['$special_string'];
    if (typeof name === 'string') found.add(name);
    return found;
  }
  for (const item of Object.values(value)) collectSpecialStrings(item, found);
  return found;
}

describe('TypeScript SDK authoritative budget-control contract boundary', () => {
  it('re-exports the exact post-provider NUMERIC(44,18) validator', () => {
    const parsed = v.safeParse(
      CanonicalPostProviderCostDecimalSchema,
      '99999999999999999999999999.1200',
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.output).toBe('99999999999999999999999999.12');
  });

  it('replays the same complete corpus through SDK-owned schema exports', () => {
    expect(corpus.$schema_version).toBe('1.0');
    expect(corpus.description.length).toBeGreaterThan(0);
    const validSchemas = new Set(
      corpus.fixtures.filter((fixture) => fixture.valid).map((fixture) => fixture.schema),
    );
    const names = corpus.fixtures.map((fixture) => fixture.name);
    const sentinels = new Set<string>();
    const stringSentinels = new Set<string>();
    for (const fixture of corpus.fixtures) {
      for (const sentinel of collectSpecialNumbers(fixture.value)) sentinels.add(sentinel);
      for (const sentinel of collectSpecialStrings(fixture.value)) stringSentinels.add(sentinel);
    }
    expect(new Set(names).size).toBe(names.length);
    expect([...validSchemas].sort()).toEqual([...SCHEMA_KEYS].sort());
    expect([...sentinels].sort()).toEqual(Object.keys(specialNumbers).sort());
    expect([...stringSentinels].sort()).toEqual(Object.keys(specialStrings).sort());
  });

  it.each(corpus.fixtures)('$name [$schema]', (fixture) => {
    const result = v.safeParse(schemas[fixture.schema], materializeSpecialValues(fixture.value));
    expect(result.success).toBe(fixture.valid);
    if (!result.success || !Object.hasOwn(fixture, 'expected_output')) return;
    expect(result.output).toStrictEqual(fixture.expected_output);
  });
});
