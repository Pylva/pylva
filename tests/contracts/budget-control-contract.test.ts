import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  BudgetControlCapabilitiesResponseSchema,
  BudgetControlErrorResponseSchema,
  CommitUsageRequestSchema,
  CommitUsageResponseSchema,
  ExtendUsageRequestSchema,
  ExtendUsageResponseSchema,
  ReleaseUsageRequestSchema,
  ReleaseUsageResponseSchema,
  ReserveUsageRequestSchema,
  ReserveUsageResponseSchema,
} from '@pylva/shared';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';

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
  readFileSync(path.resolve(process.cwd(), 'tests/contracts/budget-control-contract.json'), 'utf8'),
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

function collectStringField(value: unknown, field: string, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectStringField(item, field, found);
    return found;
  }
  if (!isRecord(value)) return found;
  const candidate = value[field];
  if (typeof candidate === 'string') found.add(candidate);
  for (const item of Object.values(value)) collectStringField(item, field, found);
  return found;
}

describe('authoritative budget-control golden contract', () => {
  it('has an explicit, complete, unambiguous manifest', () => {
    expect(corpus.$schema_version).toBe('1.0');
    expect(corpus.description.length).toBeGreaterThan(0);
    expect(Array.isArray(corpus.fixtures)).toBe(true);

    const names = new Set<string>();
    const validSchemas = new Set<SchemaKey>();
    const sentinels = new Set<string>();
    const stringSentinels = new Set<string>();
    const allowedFixtureKeys = new Set(['name', 'schema', 'valid', 'value', 'expected_output']);

    for (const fixture of corpus.fixtures) {
      expect(typeof fixture.name).toBe('string');
      expect(names.has(fixture.name)).toBe(false);
      names.add(fixture.name);
      expect(SCHEMA_KEYS).toContain(fixture.schema);
      expect(typeof fixture.valid).toBe('boolean');
      expect(Object.keys(fixture).every((key) => allowedFixtureKeys.has(key))).toBe(true);
      if (fixture.valid) validSchemas.add(fixture.schema);
      for (const sentinel of collectSpecialNumbers(fixture.value)) sentinels.add(sentinel);
      for (const sentinel of collectSpecialStrings(fixture.value)) stringSentinels.add(sentinel);
    }

    expect([...validSchemas].sort()).toEqual([...SCHEMA_KEYS].sort());
    expect([...sentinels].sort()).toEqual(Object.keys(specialNumbers).sort());
    expect([...stringSentinels].sort()).toEqual(Object.keys(specialStrings).sort());

    const validValues = corpus.fixtures
      .filter((fixture) => fixture.valid)
      .map((fixture) => fixture.value);
    expect([...collectStringField(validValues, 'decision')].sort()).toEqual([
      'bypassed',
      'denied',
      'reserved',
      'unavailable',
    ]);
    expect([...collectStringField(validValues, 'state')].sort()).toEqual([
      'committed',
      'refused',
      'released',
      'reserved',
    ]);
    const validBypassReasons = new Set(
      corpus.fixtures
        .filter(
          (fixture) =>
            fixture.valid &&
            fixture.schema === 'reservation_response' &&
            isRecord(fixture.value) &&
            fixture.value['decision'] === 'bypassed',
        )
        .map((fixture) => (isRecord(fixture.value) ? fixture.value['reason'] : undefined))
        .filter((reason): reason is string => typeof reason === 'string'),
    );
    expect([...validBypassReasons].sort()).toEqual([
      'control_disabled',
      'no_applicable_budget',
      'shadow_control_unavailable',
      'shadow_would_allow',
      'shadow_would_deny',
    ]);
    expect([...collectStringField(validValues, 'framework')].sort()).toEqual([
      'crewai',
      'langgraph',
      'mastra',
      'none',
      'openai-agents',
      'pydantic-ai',
    ]);
    expect([...collectStringField(validValues, 'status')].sort()).toEqual([
      'aborted',
      'failure',
      'retry',
      'success',
    ]);
    expect([...collectStringField(validValues, 'period')].sort()).toEqual([
      'day',
      'hour',
      'month',
      'week',
    ]);
    expect([...collectStringField(validValues, 'code')].sort()).toEqual([
      'IDEMPOTENCY_CONFLICT',
      'INTERNAL_ERROR',
      'INVALID_API_KEY',
      'RATE_LIMIT_EXCEEDED',
      'RESERVATION_STATE_CONFLICT',
      'RESOURCE_NOT_FOUND',
      'VALIDATION_ERROR',
      'WRONG_SCOPE',
      'advisory_budget_exceeded',
    ]);
  });

  it.each(corpus.fixtures)('$name [$schema]', (fixture) => {
    const result = v.safeParse(schemas[fixture.schema], materializeSpecialValues(fixture.value));
    expect(result.success).toBe(fixture.valid);
    if (!result.success || !Object.hasOwn(fixture, 'expected_output')) return;
    expect(result.output).toStrictEqual(fixture.expected_output);
  });
});
