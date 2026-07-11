// Contract fixture replay — verifies that the canonical (request, response)
// pairs in tests/contracts/ingest-contract.json are well-formed against the
// shared schema. Full integration tests (hitting the real route + ClickHouse)
// live under tests/integration/ingest/ and run via vitest.integration.config.ts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import * as v from 'valibot';
import {
  IngestRequestSchema,
  IngestResponseSchema,
  TelemetryEventSchema,
} from '@pylva/shared';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT_PATH = path.resolve(__dirname, 'ingest-contract.json');

interface Fixture {
  name: string;
  description: string;
  request?: unknown;
  request_generator?: string;
  generator_args?: { count: number; provider: string; model: string };
  response?: unknown;
  response_status?: number;
  response_error_type?: string;
  response_error_code?: string;
}

function generateHappyBatch(args: { count: number; provider: string; model: string }): {
  batch_id: string;
  sdk_version: string;
  events: unknown[];
} {
  const events = [];
  for (let i = 0; i < args.count; i++) {
    events.push({
      schema_version: '1.6',
      run_id: '11111111-1111-4111-8111-111111111111',
      parent_run_id: null,
      trace_id: '22222222-2222-4222-8222-222222222222',
      // Deterministic span_id per index so generated batches don't collide across tests.
      span_id: `3${String(i).padStart(7, '0')}-3333-4333-8333-333333333333`.slice(0, 36),
      parent_span_id: null,
      customer_id: `cust_${i}`,
      step_name: 'answer',
      model: args.model,
      provider: args.provider,
      tokens_in: 10,
      tokens_out: 5,
      latency_ms: 100,
      tool_name: null,
      status: 'success',
      framework: 'none',
      instrumentation_tier: 'sdk_wrapper',
      cost_source: 'auto',
      metric: null,
      metric_value: null,
      stream_aborted: false,
      abort_savings_usd: 0,
      sdk_version: '0.0.1',
      timestamp: '2026-04-18T10:00:00.000Z',
    });
  }
  return {
    batch_id: '5a5ed760-8c72-4c7d-9a1d-0d2a9bde0002',
    sdk_version: '0.0.1',
    events,
  };
}

describe('ingest contract fixtures', () => {
  const raw = fs.readFileSync(CONTRACT_PATH, 'utf-8');
  const fixtureFile = JSON.parse(raw) as { fixtures: Fixture[]; $schema_version: string };

  it('version matches v1.6 schema', () => {
    expect(fixtureFile.$schema_version).toBe('1.6');
  });

  it('loads 10 fixtures', () => {
    expect(fixtureFile.fixtures).toHaveLength(10);
  });

  for (const fixture of fixtureFile.fixtures) {
    describe(fixture.name, () => {
      const request =
        fixture.request ??
        (fixture.request_generator === 'generate_happy_batch' && fixture.generator_args
          ? generateHappyBatch(fixture.generator_args)
          : null);

      // Oversized-batch fixture should FAIL IngestRequestSchema validation (max 100 events).
      const shouldParseRequest = fixture.name !== 'oversized_batch_rejected';

      if (shouldParseRequest && request) {
        it('request parses against IngestRequestSchema', () => {
          const parsed = v.safeParse(IngestRequestSchema, request);
          if (!parsed.success) {
            throw new Error(
              `fixture "${fixture.name}" failed: ${parsed.issues[0].message} at ${parsed.issues[0].path?.map((p) => String((p as { key: unknown }).key)).join('.') ?? ''}`,
            );
          }
          expect(parsed.output.events.length).toBeGreaterThan(0);
        });
      } else if (fixture.name === 'oversized_batch_rejected') {
        it('oversized batch FAILS IngestRequestSchema (max 100)', () => {
          const parsed = v.safeParse(IngestRequestSchema, request);
          expect(parsed.success).toBe(false);
        });
      }

      if (fixture.response) {
        it('response parses against IngestResponseSchema', () => {
          const parsed = v.safeParse(IngestResponseSchema, fixture.response);
          if (!parsed.success) {
            throw new Error(
              `response for fixture "${fixture.name}" failed: ${parsed.issues[0].message}`,
            );
          }
        });
      }

      // Sanity check on partial-batch fixture: 3 valid + 2 invalid.
      if (fixture.name === 'partial_batch_3_valid_2_invalid' && request) {
        it('has 5 total events', () => {
          const req = request as { events: unknown[] };
          expect(req.events).toHaveLength(5);
        });
      }

      // Non-LLM fixture must describe a valid reported-tier event.
      if (fixture.name === 'non_llm_reported_metric' && request) {
        it('event has instrumentation_tier=reported and metric set', () => {
          const req = request as { events: Array<Record<string, unknown>> };
          const first = req.events[0];
          expect(first?.['instrumentation_tier']).toBe('reported');
          expect(first?.['metric']).toBe('search_api_call');
          const parsed = v.safeParse(TelemetryEventSchema, first);
          expect(parsed.success).toBe(true);
        });
      }
    });
  }
});
