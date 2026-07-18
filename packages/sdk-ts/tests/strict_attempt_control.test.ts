import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetConfigForTests, init } from '../src/core/config.js';
import { executeControlledAttempt } from '../src/core/control_attempt.js';
import {
  _parseStrictResponseForTests,
  _resetStrictControlForTests,
  ownsStrictReservation,
  strictReserveLlm,
} from '../src/core/strict_attempt_control.js';
import {
  parseCommitResponse,
  parseControlCapabilities,
  parseControlError,
  parseExtendResponse,
  parseReleaseResponse,
  parseReserveResponse,
} from '../src/core/control_wire.js';
import * as privateControlRuntime from '../src/internal/control-runtime.js';

type ResponseSchema =
  | 'capabilities_response'
  | 'reservation_response'
  | 'commit_response'
  | 'release_response'
  | 'extend_response'
  | 'error_response';

interface Fixture {
  name: string;
  schema: string;
  valid: boolean;
  value: unknown;
}

const responseSchemas = new Set<ResponseSchema>([
  'capabilities_response',
  'reservation_response',
  'commit_response',
  'release_response',
  'extend_response',
  'error_response',
]);
const corpus = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../tests/contracts/budget-control-contract.json', import.meta.url),
    ),
    'utf8',
  ),
) as { fixtures: Fixture[] };
const fixtures = corpus.fixtures.filter(
  (fixture): fixture is Fixture & { schema: ResponseSchema } =>
    responseSchemas.has(fixture.schema as ResponseSchema),
);

const genericParsers: Record<ResponseSchema, (value: unknown) => unknown | null> = {
  capabilities_response: parseControlCapabilities,
  reservation_response: parseReserveResponse,
  commit_response: parseCommitResponse,
  release_response: parseReleaseResponse,
  extend_response: parseExtendResponse,
  error_response: parseControlError,
};

const specialNumbers: Record<string, number> = {
  nan: Number.NaN,
  positive_infinity: Number.POSITIVE_INFINITY,
  negative_infinity: Number.NEGATIVE_INFINITY,
};
const specialStrings: Record<string, string> = {
  lone_high_surrogate: '\uD800',
  lone_low_surrogate: '\uDFFF',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function materialize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(materialize);
  if (!isRecord(value)) return value;
  if (Object.keys(value).length === 1 && '$special_number' in value) {
    return specialNumbers[String(value['$special_number'])];
  }
  if (Object.keys(value).length === 1 && '$special_string' in value) {
    return specialStrings[String(value['$special_string'])];
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, materialize(item)]));
}

function camelize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase()),
      camelize(item),
    ]),
  );
}

function expectedStrictMapping(schema: ResponseSchema, parsed: unknown): unknown {
  if (schema === 'error_response') {
    const error = (parsed as { error: { code: string } }).error;
    return { code: error.code };
  }
  const mapped = camelize(parsed) as Record<string, unknown>;
  if (schema !== 'reservation_response') return mapped;
  if (mapped['decision'] === 'bypassed') return { ...mapped, local: false };
  if (mapped['decision'] === 'unavailable') {
    return { ...mapped, controlReason: mapped['reason'], local: false };
  }
  return mapped;
}

const KEY = `pv_live_aabbccdd_${'a'.repeat(32)}`;
const SECOND_KEY = `pv_live_eeff0011_${'b'.repeat(32)}`;

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

const capabilities = {
  schema_version: '1.0',
  control_enabled: true,
  min_reservation_ttl_seconds: 30,
  default_reservation_ttl_seconds: 300,
  max_reservation_ttl_seconds: 3600,
  server_time: '2026-07-14T09:00:00.000Z',
};

function attempt(dispatch = vi.fn(() => 'provider-result')) {
  return {
    dispatch,
    input: {
      provider: 'openai',
      model: 'gpt-test-2026-01-01',
      estimatedInputTokens: 10,
      maxOutputTokens: 20,
      dispatch,
    },
  };
}

describe('canonical strict attempt control', () => {
  beforeEach(() => {
    _resetConfigForTests();
    _resetStrictControlForTests();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    _resetConfigForTests();
    _resetStrictControlForTests();
  });

  it('keeps reset and test hooks off the canonical private runtime surface', () => {
    expect(Object.keys(privateControlRuntime)).not.toContain('_resetStrictControlForTests');
    expect(
      Object.keys(privateControlRuntime).filter((name) => /(?:ForTests|^_?reset)/u.test(name)),
    ).toEqual([]);
  });

  it('matches all 73 authoritative JSON response/error decisions and every valid mapping', () => {
    expect(fixtures).toHaveLength(73);
    for (const fixture of fixtures) {
      const value = materialize(fixture.value);
      const strict = _parseStrictResponseForTests(fixture.schema, value);
      const generic = genericParsers[fixture.schema](value);
      expect(strict !== null, `${fixture.name}: strict validity`).toBe(fixture.valid);
      expect(generic !== null, `${fixture.name}: generic validity`).toBe(fixture.valid);
      if (strict !== null && generic !== null) {
        expect(strict, `${fixture.name}: mapped output`).toStrictEqual(
          expectedStrictMapping(fixture.schema, generic),
        );
      }
    }
  });

  it('owns only its original receipt and invalidates ownership after identity replacement', async () => {
    const reservationId = '33333333-3333-4333-8333-333333333333';
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json(capabilities))
      .mockImplementationOnce(async (_url, request) => {
        const body = JSON.parse(String(request?.body)) as { operation_id: string };
        return json({
          schema_version: '1.0',
          decision: 'reserved',
          allowed: true,
          decision_id: '22222222-2222-4222-8222-222222222222',
          operation_id: body.operation_id,
          reservation_id: reservationId,
          state: 'reserved',
          reserved_usd: '1',
          remaining_usd: '9',
          expires_at: '2026-07-14T09:05:00.000Z',
          warnings: [],
        });
      });
    init({
      apiKey: KEY,
      endpoint: 'https://control.test',
      control: { mode: 'enforce', onUnavailable: 'deny' },
    });
    const operationId = '11111111-1111-4111-8111-111111111111';
    const receipt = await strictReserveLlm({
      operationId,
      customerId: 'customer_1',
      traceId: '44444444-4444-4444-8444-444444444444',
      spanId: '55555555-5555-4555-8555-555555555555',
      parentSpanId: null,
      stepName: null,
      framework: 'none',
      provider: 'openai',
      model: 'gpt-test-2026-01-01',
      estimatedInputTokens: 10,
      maxOutputTokens: 20,
    });

    expect(ownsStrictReservation(receipt, operationId, reservationId)).toBe(true);
    expect(ownsStrictReservation({ ...receipt }, operationId, reservationId)).toBe(false);
    expect(
      ownsStrictReservation(receipt, operationId, '66666666-6666-4666-8666-666666666666'),
    ).toBe(false);

    init({
      apiKey: SECOND_KEY,
      endpoint: 'https://control.test',
      control: { mode: 'enforce', onUnavailable: 'deny' },
    });
    expect(ownsStrictReservation(receipt, operationId, reservationId)).toBe(false);
  });

  it('rejects a semantically invalid denial before provider dispatch', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json(capabilities))
      .mockImplementationOnce(async (_url, request) => {
        const body = JSON.parse(String(request?.body)) as { operation_id: string };
        return json({
          schema_version: '1.0',
          decision: 'denied',
          allowed: false,
          decision_id: '22222222-2222-4222-8222-222222222222',
          operation_id: body.operation_id,
          state: 'refused',
          deciding_rule: {
            rule_id: '33333333-3333-4333-8333-333333333333',
            scope: 'pooled',
            customer_id: null,
            period: 'day',
            period_start: '2026-07-14T00:00:00.000Z',
            period_end: '2026-07-15T00:00:00.000Z',
          },
          committed_usd: '1',
          reserved_usd: '0',
          unresolved_usd: '0',
          requested_usd: '1',
          limit_usd: '10',
          // Inconsistent: this request does not exceed the limit.
          remaining_usd: '9',
          warnings: [],
        });
      });
    init({
      apiKey: KEY,
      endpoint: 'https://control.test',
      control: { mode: 'enforce', onUnavailable: 'deny' },
    });
    const launched = attempt();

    await expect(executeControlledAttempt(launched.input)).rejects.toMatchObject({
      name: 'PylvaControlUnavailableError',
      reason: 'invalid_response',
    });
    expect(launched.dispatch).not.toHaveBeenCalled();
  });

  it('classifies its bounded capability wait as timeout without dispatch', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, request) =>
        new Promise<Response>((_resolve, reject) => {
          request?.signal?.addEventListener('abort', () => reject(request.signal?.reason), {
            once: true,
          });
        }),
    );
    init({
      apiKey: KEY,
      endpoint: 'https://control.test',
      control: { mode: 'enforce', onUnavailable: 'deny', timeoutMs: 100 },
    });
    const launched = attempt();

    await expect(executeControlledAttempt(launched.input)).rejects.toMatchObject({
      name: 'PylvaControlUnavailableError',
      reason: 'timeout',
      retryable: true,
    });
    expect(launched.dispatch).not.toHaveBeenCalled();
  });

  it('unrefs an in-flight deadline and classifies identity replacement before dispatch', async () => {
    let started!: () => void;
    const pending = new Promise<void>((resolve) => {
      started = resolve;
    });
    const timerSpy = vi.spyOn(globalThis, 'setTimeout');
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (_url, request) =>
        new Promise<Response>((_resolve, reject) => {
          started();
          request?.signal?.addEventListener('abort', () => reject(request.signal?.reason), {
            once: true,
          });
        }),
    );
    init({
      apiKey: KEY,
      endpoint: 'https://control.test',
      control: { mode: 'enforce', onUnavailable: 'deny' },
    });
    const launched = attempt();
    const result = executeControlledAttempt(launched.input);
    await pending;
    const deadline = timerSpy.mock.results.at(-1)?.value as NodeJS.Timeout | undefined;
    expect(deadline?.hasRef()).toBe(false);
    init({
      apiKey: SECOND_KEY,
      endpoint: 'https://control.test',
      control: { mode: 'enforce', onUnavailable: 'deny' },
    });

    await expect(result).rejects.toMatchObject({
      name: 'PylvaControlUnavailableError',
      reason: 'configuration_changed',
    });
    expect(launched.dispatch).not.toHaveBeenCalled();
  });
});
