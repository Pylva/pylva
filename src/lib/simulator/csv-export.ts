import type { SimulatorResult } from '@pylva/shared';
import { csvEscapeSafe } from '../csv.js';

export function simulatorResultToCsv(result: SimulatorResult): string {
  const headers = [
    'customer_id',
    'provider',
    'step_name',
    'original_model',
    'simulated_model',
    'original_cost_usd',
    'simulated_cost_usd',
    'savings_usd',
    'event_count',
  ];

  const rows = result.breakdown.map((b) => [
    csvEscapeSafe(b.customer_id),
    csvEscapeSafe(b.provider),
    csvEscapeSafe(b.step_name ?? 'unattributed'),
    csvEscapeSafe(b.original_model),
    csvEscapeSafe(b.simulated_model),
    b.original_cost_usd.toFixed(6),
    b.simulated_cost_usd.toFixed(6),
    (b.original_cost_usd - b.simulated_cost_usd).toFixed(6),
    String(b.event_count),
  ]);

  const summaryRow = [
    csvEscapeSafe('TOTAL'),
    '',
    '',
    '',
    '',
    result.original_cost_usd.toFixed(6),
    result.simulated_cost_usd.toFixed(6),
    result.savings_usd.toFixed(6),
    '',
  ];

  return [headers.join(','), ...rows.map((r) => r.join(',')), summaryRow.join(',')].join('\n');
}
