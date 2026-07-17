import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildReserveWire,
  parseCommitResponse,
  parseCommitWire,
  parseControlCapabilities,
  parseControlError,
  parseExtendResponse,
  parseExtendWire,
  parseReleaseResponse,
  parseReleaseWire,
  parseReserveResponse,
  parseReserveWire,
} from '../src/core/control_wire.js';

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
  fixtures: ContractFixture[];
}

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
    if (typeof name !== 'string' || !(name in specialNumbers)) throw new Error('bad fixture');
    return specialNumbers[name as SpecialNumberName];
  }
  if (Object.keys(value).length === 1 && '$special_string' in value) {
    const name = value['$special_string'];
    if (typeof name !== 'string' || !(name in specialStrings)) throw new Error('bad fixture');
    return specialStrings[name as SpecialStringName];
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, materializeSpecialValues(item)]),
  );
}

const parsers: Record<SchemaKey, (value: unknown) => unknown | null> = {
  capabilities_response: parseControlCapabilities,
  reservation_request: parseReserveWire,
  reservation_response: parseReserveResponse,
  commit_request: parseCommitWire,
  commit_response: parseCommitResponse,
  release_request: parseReleaseWire,
  release_response: parseReleaseResponse,
  extend_request: parseExtendWire,
  extend_response: parseExtendResponse,
  error_response: parseControlError,
};

const operationId = '11111111-1111-4111-8111-111111111111';
const decisionId = '22222222-2222-4222-8222-222222222222';
const reservationId = '33333333-3333-4333-8333-333333333333';

const reserved = {
  schema_version: '1.0',
  decision: 'reserved',
  allowed: true,
  decision_id: decisionId,
  operation_id: operationId,
  reservation_id: reservationId,
  state: 'reserved',
  reserved_usd: '1',
  remaining_usd: '9',
  expires_at: '2026-07-14T09:05:00.000Z',
  warnings: [],
};

const facade = {
  kind: 'llm',
  operationId,
  customerId: 'customer_1',
  traceId: '44444444-4444-4444-8444-444444444444',
  spanId: '55555555-5555-4555-8555-555555555555',
  parentSpanId: null,
  provider: 'openai',
  model: 'gpt-5',
  estimatedInputTokens: 1,
  maxOutputTokens: 1,
};

describe('compact authoritative-control wire parser', () => {
  it('pins the complete shared authority corpus', () => {
    expect(corpus.$schema_version).toBe('1.0');
    expect(corpus.fixtures).toHaveLength(150);
    expect(new Set(corpus.fixtures.map((fixture) => fixture.name)).size).toBe(150);
    expect(new Set(corpus.fixtures.map((fixture) => fixture.schema))).toEqual(new Set(SCHEMA_KEYS));
  });

  it.each(corpus.fixtures)('$name [$schema]', (fixture) => {
    const result = parsers[fixture.schema](materializeSpecialValues(fixture.value));
    expect(result !== null).toBe(fixture.valid);
    if (result === null || !Object.hasOwn(fixture, 'expected_output')) return;
    expect(result).toStrictEqual(fixture.expected_output);
  });

  it('accepts additive response data while discarding it', () => {
    expect(parseReserveResponse({ ...reserved, future_field: { any: 'value' } })).toEqual(reserved);
  });

  it('rejects request accessors, symbols, non-enumerable fields, and foreign prototypes', () => {
    let reads = 0;
    const accessor = { ...facade } as Record<string, unknown>;
    Object.defineProperty(accessor, 'model', {
      enumerable: true,
      get() {
        reads += 1;
        return 'gpt-5';
      },
    });
    const symbol = { ...facade } as Record<PropertyKey, unknown>;
    symbol[Symbol('secret')] = true;
    const hidden = { ...facade };
    Object.defineProperty(hidden, 'secret', { enumerable: false, value: true });
    const foreign = Object.assign(Object.create({ inherited: true }) as object, facade);

    for (const value of [accessor, symbol, hidden, foreign]) {
      expect(buildReserveWire(value, 'enforce')).toBeNull();
    }
    expect(reads).toBe(0);
  });

  it('rejects proxies before invoking their traps', () => {
    let traps = 0;
    const proxy = new Proxy(facade, {
      getPrototypeOf(target) {
        traps += 1;
        return Reflect.getPrototypeOf(target);
      },
      ownKeys(target) {
        traps += 1;
        return Reflect.ownKeys(target);
      },
    });
    expect(buildReserveWire(proxy, 'enforce')).toBeNull();
    expect(parseReserveResponse(new Proxy(reserved, {}))).toBeNull();
    expect(traps).toBe(0);
  });

  it('rejects warning accessors and sparse or extended arrays without reading them', () => {
    let reads = 0;
    const warning = {
      code: 'advisory_budget_exceeded',
      rule_id: '77777777-7777-4777-8777-777777777777',
      limit_usd: '1',
    } as Record<string, unknown>;
    Object.defineProperty(warning, 'projected_usd', {
      enumerable: true,
      get() {
        reads += 1;
        return '2';
      },
    });
    expect(parseReserveResponse({ ...reserved, warnings: [warning] })).toBeNull();

    const sparse = new Array(1);
    expect(parseReserveResponse({ ...reserved, warnings: sparse })).toBeNull();
    const extended: unknown[] & Record<string, unknown> = [];
    extended['extra'] = true;
    expect(parseReserveResponse({ ...reserved, warnings: extended })).toBeNull();
    expect(reads).toBe(0);
  });
});
