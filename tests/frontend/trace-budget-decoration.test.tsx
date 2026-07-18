import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TraceTree } from '@/components/dashboard/TraceTree';
import { budgetActivity, BUDGET_FIXTURE_IDS } from '../_helpers/budget-activity-fixtures';

describe('<TraceTree> authoritative charge decoration', () => {
  it('decorates the matching cost span exactly once instead of adding a second row', () => {
    const charged = budgetActivity({ status: 'charged' });
    const { container } = render(
      <TraceTree
        spans={[
          {
            trace_id: BUDGET_FIXTURE_IDS.trace,
            span_id: BUDGET_FIXTURE_IDS.span,
            parent_span_id: null,
            step_name: 'answer_question',
            provider: 'openai',
            model: 'gpt-4o-mini',
            tokens_in: 10,
            tokens_out: 5,
            cost_usd: 0.0000031,
            latency_ms: 42,
            status: 'success',
            timestamp: '2026-07-14T09:30:00.000Z',
          },
        ]}
        controlActions={[charged]}
      />,
    );

    expect(container.querySelectorAll('li')).toHaveLength(1);
    expect(screen.getAllByLabelText('Budget status: Charged')).toHaveLength(1);
    expect(screen.getByText('$0.0000031 · 42 ms')).toBeInTheDocument();
    expect(screen.getByText(/PostgreSQL cost event 44444444…/)).toBeInTheDocument();
  });
});
