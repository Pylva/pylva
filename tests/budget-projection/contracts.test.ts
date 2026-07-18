import { describe, expect, it } from 'vitest';
import {
  authoritativePayloadToClickHouseRow,
  BudgetProjectionPayloadError,
  parseAuthoritativeBudgetCostEventPayload,
} from '../../src/lib/budget-projection/contracts.js';
import { BUILDER_ID, PAYLOAD_HASH, llmPayload, toolPayload } from './fixtures.js';

describe('authoritative budget projection payload contract', () => {
  it('parses the deterministic tool payload and preserves exact decimals', () => {
    const payload = toolPayload();
    expect(parseAuthoritativeBudgetCostEventPayload(payload)).toEqual(payload);
  });

  it('parses the deterministic LLM payload', () => {
    const payload = llmPayload({
      step_name: '',
      parent_span_id: '00000000-0000-0000-0000-000000000000',
    });
    expect(parseAuthoritativeBudgetCostEventPayload(payload)).toEqual(payload);
  });

  it('maps to the widened ClickHouse row without IEEE-754 conversion', () => {
    const payload = toolPayload({
      cost_usd: '99999999999999999999999999.123456789012345678',
      metric_value: '99999999999999999999.123456789012345678',
      stream_aborted: true,
      is_demo: true,
    });
    const row = authoritativePayloadToClickHouseRow(payload, PAYLOAD_HASH);
    expect(row).toMatchObject({
      timestamp: '2026-07-14 09:10:11.123',
      cost_usd: payload.cost_usd,
      metric_value: payload.metric_value,
      stream_aborted: 1,
      is_demo: 1,
      savings_usd: 0,
      payload_hash: PAYLOAD_HASH,
    });
    expect(JSON.parse(row.metadata)).toEqual(payload.metadata);
  });

  it.each([
    ['non-object', null],
    ['array', []],
    ['string', 'payload'],
  ])('rejects a %s top-level payload', (_label, value) => {
    expect(() => parseAuthoritativeBudgetCostEventPayload(value)).toThrow(
      BudgetProjectionPayloadError,
    );
  });

  it('rejects missing and additive keys for schema 1.6', () => {
    const missing = { ...toolPayload() } as Record<string, unknown>;
    delete missing['operation_id'];
    expect(() => parseAuthoritativeBudgetCostEventPayload(missing)).toThrow(
      /operation_id.*required/,
    );
    expect(() =>
      parseAuthoritativeBudgetCostEventPayload({ ...toolPayload(), prompt: 'private' }),
    ).toThrow(/prompt.*not part/);
  });

  it.each([
    ['event_id', '22222222-2222-4222-8222-22222222222Z'],
    ['event_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'.toUpperCase()],
    ['parent_span_id', '00000000-0000-0000-0000-00000000000Z'],
  ])('rejects a noncanonical %s UUID', (field, value) => {
    expect(() =>
      parseAuthoritativeBudgetCostEventPayload({ ...toolPayload(), [field]: value }),
    ).toThrow(new RegExp(field));
  });

  it.each([
    '2026-07-14T09:10:11Z',
    '2026-07-14T09:10:11.123+00:00',
    '2026-02-30T09:10:11.123Z',
    '2026-07-14 09:10:11.123Z',
  ])('rejects a noncanonical or impossible timestamp %s', (timestamp) => {
    expect(() => parseAuthoritativeBudgetCostEventPayload(toolPayload({ timestamp }))).toThrow(
      /timestamp/,
    );
  });

  it('rejects a customer identity not namespaced to the typed builder', () => {
    expect(() =>
      parseAuthoritativeBudgetCostEventPayload(
        toolPayload({ customer_id: `${BUILDER_ID}:customer:escape` }),
      ),
    ).toThrow(/customer_id/);
    expect(() =>
      parseAuthoritativeBudgetCostEventPayload(
        toolPayload({ customer_id: `99999999-9999-4999-8999-999999999999:customer_1` }),
      ),
    ).toThrow(/customer_id/);
  });

  it.each(['01', '1.0', '1.', '-1', 'NaN', 'Infinity', '1e-3', '1.1234567890123456789'])(
    'rejects noncanonical decimal text %s',
    (cost_usd) => {
      expect(() => parseAuthoritativeBudgetCostEventPayload(toolPayload({ cost_usd }))).toThrow(
        /cost_usd/,
      );
    },
  );

  it('rejects a nonzero controlled abort savings amount', () => {
    expect(() =>
      parseAuthoritativeBudgetCostEventPayload(toolPayload({ abort_savings: '0.1' })),
    ).toThrow(/abort_savings/);
  });

  it.each([
    { tokens_in: -1 },
    { tokens_out: 4_294_967_296 },
    { latency_ms: 1.5 },
    { latency_ms: Number.NaN },
    { stream_aborted: 0 },
    { is_demo: 'false' },
  ])('rejects unsafe ClickHouse scalar bounds: %j', (override) => {
    expect(() =>
      parseAuthoritativeBudgetCostEventPayload({ ...toolPayload(), ...override }),
    ).toThrow(BudgetProjectionPayloadError);
  });

  it.each([
    { retention_days: 0 },
    { retention_days: 18_251 },
    { retention_days: 366, billing_retention_days: 365 },
    { billing_retention_days: 18_251 },
  ])('rejects an invalid retention pair: %j', (override) => {
    expect(() =>
      parseAuthoritativeBudgetCostEventPayload({ ...toolPayload(), ...override }),
    ).toThrow(/retention/);
  });

  it('rejects contradictory LLM and tool projection dimensions', () => {
    expect(() => parseAuthoritativeBudgetCostEventPayload(llmPayload({ model: null }))).toThrow(
      /sdk_wrapper/,
    );
    expect(() => parseAuthoritativeBudgetCostEventPayload(toolPayload({ tokens_in: 1 }))).toThrow(
      /reported/,
    );
    expect(() =>
      parseAuthoritativeBudgetCostEventPayload(toolPayload({ cost_source: 'auto' })),
    ).toThrow(/reported/);
  });

  it.each([' ', '\n', '\u0000bad', '\ud800'])('rejects an unsafe provider string', (provider) => {
    expect(() => parseAuthoritativeBudgetCostEventPayload(llmPayload({ provider }))).toThrow(
      /provider/,
    );
  });

  it('rejects malformed payload hashes at the final storage boundary', () => {
    expect(() => authoritativePayloadToClickHouseRow(toolPayload(), 'A'.repeat(64))).toThrow(
      /payload_hash/,
    );
    expect(() => authoritativePayloadToClickHouseRow(toolPayload(), 'a'.repeat(63))).toThrow(
      /payload_hash/,
    );
  });

  it('accepts only the bounded flat metadata contract emitted by the ledger', () => {
    const payload = llmPayload({
      metadata: {
        provider_request_id: 'r'.repeat(255),
        token_count_source: 'estimated',
        finish_reason: 'f'.repeat(100),
        sdk_version: '1.2.0+build.7',
        sdk_language: 'python',
        framework: 'pydantic-ai',
        pricing_snapshot_hash: 'd'.repeat(64),
        usage_snapshot_hash: 'e'.repeat(64),
      },
    });

    expect(parseAuthoritativeBudgetCostEventPayload(payload).metadata).toEqual(payload.metadata);
  });

  it.each(['prompt', 'messages', 'tool_arguments', 'content', 'unknown'])(
    'rejects sensitive or unknown metadata key %s',
    (key) => {
      expect(() =>
        parseAuthoritativeBudgetCostEventPayload(
          toolPayload({ metadata: { ...toolPayload().metadata, [key]: 'private' } }),
        ),
      ).toThrow(new RegExp(`metadata\\.${key}`));
    },
  );

  it.each([
    ['provider_request_id', 'x'.repeat(256)],
    ['finish_reason', 'x'.repeat(101)],
    ['token_count_source', 'guessed'],
    ['sdk_version', 'x'.repeat(51)],
    ['sdk_language', 'ruby'],
    ['framework', 'custom-agent'],
    ['tool_name', 'unsafe<script>'],
    ['cost_source_slug', '../escape'],
    ['pricing_snapshot_hash', 'A'.repeat(64)],
    ['usage_snapshot_hash', 'a'.repeat(63)],
  ])('rejects invalid metadata scalar %s', (field, value) => {
    expect(() =>
      parseAuthoritativeBudgetCostEventPayload(
        toolPayload({ metadata: { ...toolPayload().metadata, [field]: value } }),
      ),
    ).toThrow(new RegExp(`metadata\\.${field}`));
  });

  it('rejects missing, deep, accessor, symbolic, and tier-inapplicable metadata', () => {
    const missingHash = { ...toolPayload().metadata };
    delete missingHash['usage_snapshot_hash'];
    expect(() =>
      parseAuthoritativeBudgetCostEventPayload(toolPayload({ metadata: missingHash })),
    ).toThrow(/metadata\.usage_snapshot_hash.*required/);

    expect(() =>
      parseAuthoritativeBudgetCostEventPayload(
        toolPayload({
          metadata: { ...toolPayload().metadata, finish_reason: { nested: 'private' } } as never,
        }),
      ),
    ).toThrow(/metadata\.finish_reason/);

    const accessor = { ...toolPayload().metadata } as Record<string, string>;
    Object.defineProperty(accessor, 'finish_reason', {
      enumerable: true,
      get: () => 'private',
    });
    expect(() =>
      parseAuthoritativeBudgetCostEventPayload(toolPayload({ metadata: accessor })),
    ).toThrow(/enumerable JSON data property/);

    const symbolic = { ...toolPayload().metadata } as Record<string | symbol, string>;
    symbolic[Symbol('private')] = 'secret';
    expect(() =>
      parseAuthoritativeBudgetCostEventPayload(toolPayload({ metadata: symbolic as never })),
    ).toThrow(/allowed authoritative metadata field/);

    expect(() =>
      parseAuthoritativeBudgetCostEventPayload(
        llmPayload({ metadata: { ...llmPayload().metadata, tool_name: 'search' } }),
      ),
    ).toThrow(/tool identity metadata/);
  });
});
