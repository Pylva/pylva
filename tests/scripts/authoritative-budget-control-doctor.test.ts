import { describe, expect, it } from 'vitest';
import {
  buildDoctorReport,
  parseDoctorArguments,
} from '../../scripts/authoritative-budget-control-doctor.js';

const BUILDER_ID = '11111111-1111-4111-8111-111111111111';

describe('authoritative budget-control operator doctor', () => {
  it('requires one explicit builder UUID', () => {
    expect(parseDoctorArguments(['--builder-id', BUILDER_ID])).toEqual({ builderId: BUILDER_ID });
    expect(parseDoctorArguments(['--', '--builder-id', BUILDER_ID])).toEqual({
      builderId: BUILDER_ID,
    });
    for (const arguments_ of [
      [],
      ['--builder-id'],
      ['--builder-id', 'not-a-uuid'],
      ['--other', BUILDER_ID],
    ]) {
      expect(() => parseDoctorArguments(arguments_)).toThrow('usage:');
    }
  });

  it('requires attested production postures and a ready builder cutover', () => {
    const ready = buildDoctorReport(
      BUILDER_ID,
      { ready: true, reason: null, attested: true },
      { ready: true, reason: null, attested: true },
      {
        ready: true,
        mode: 'next_period',
        cutover_at: '2026-07-17T00:00:00.000Z',
        ready_order: '1',
        ready_at: '2026-07-17T00:00:01.000Z',
      },
    );
    expect(ready.ready).toBe(true);

    expect(
      buildDoctorReport(
        BUILDER_ID,
        { ready: true, reason: null, attested: false },
        ready.checks.clickhouse_projection,
        ready.checks.builder_cutover,
      ).ready,
    ).toBe(false);
    expect(
      buildDoctorReport(
        BUILDER_ID,
        ready.checks.postgres_runtime,
        { ready: false, reason: 'identity_mismatch', attested: false },
        ready.checks.builder_cutover,
      ).ready,
    ).toBe(false);
    expect(
      buildDoctorReport(
        BUILDER_ID,
        ready.checks.postgres_runtime,
        ready.checks.clickhouse_projection,
        {
          ready: false,
          reason: 'pending',
          mode: 'next_period',
          cutover_at: '2026-07-17T00:00:00.000Z',
        },
      ).ready,
    ).toBe(false);
  });
});
