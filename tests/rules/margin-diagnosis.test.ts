// B4-4a — pure-function tests for margin / spend diagnosis. No DB / no
// ClickHouse — every fixture is an in-memory `MarginDiagnosisInput`.

import { describe, it, expect } from 'vitest';
import { DriverKind } from '@pylva/shared';
import {
  diagnoseMargin,
  type MarginDiagnosisInput,
  type ModeledSlice,
  type SteppedSlice,
  type SourcedSlice,
} from '../../src/lib/rules/margin-diagnosis.js';

function step(step_name: string | null, cost_usd: number, iterations: number): SteppedSlice {
  return { step_name, cost_usd, iterations };
}

function model(provider: string | null, model: string | null, cost_usd: number): ModeledSlice {
  return { provider, model, cost_usd };
}

function source(source: string | null, cost_usd: number): SourcedSlice {
  return { source, cost_usd };
}

function input(
  current: Partial<MarginDiagnosisInput['current']>,
  prior: Partial<MarginDiagnosisInput['prior']>,
  has_revenue_data = true,
): MarginDiagnosisInput {
  return {
    current: { steps: [], models: [], sources: [], ...current },
    prior: { steps: [], models: [], sources: [], ...prior },
    has_revenue_data,
  };
}

describe('diagnoseMargin — top drivers', () => {
  it('returns empty diagnosis when periods are identical', () => {
    const out = diagnoseMargin(
      input({ steps: [step('summarize', 1, 10)] }, { steps: [step('summarize', 1, 10)] }),
    );
    expect(out.top_drivers).toBeUndefined();
    expect(out.iteration_inflation).toBeUndefined();
    expect(out.insufficient_revenue_data).toBeUndefined();
  });

  it('ranks top drivers by absolute delta across kinds', () => {
    const out = diagnoseMargin(
      input(
        {
          steps: [step('summarize', 5, 5), step('classify', 1, 5)],
          models: [model('openai', 'gpt-4o', 100)],
          sources: [source('auto', 200)],
        },
        {
          steps: [step('summarize', 1, 5), step('classify', 1, 5)],
          models: [model('openai', 'gpt-4o', 50)],
          sources: [source('auto', 150)],
        },
      ),
    );
    expect(out.top_drivers).toBeDefined();
    expect(out.top_drivers?.length).toBe(3);
    // Top by absolute delta: source +50, model +50, step +4
    const labels = out.top_drivers?.map((d) => d.label);
    expect(labels).toContain('auto');
    expect(labels).toContain('openai/gpt-4o');
    expect(labels).toContain('summarize');
  });

  it('caps top drivers at 3', () => {
    const out = diagnoseMargin(
      input(
        {
          models: [
            model('openai', 'm1', 10),
            model('openai', 'm2', 20),
            model('openai', 'm3', 30),
            model('openai', 'm4', 40),
            model('openai', 'm5', 50),
          ],
        },
        {},
      ),
    );
    expect(out.top_drivers?.length).toBe(3);
    expect(out.top_drivers?.[0]?.label).toBe('openai/m5');
  });

  it('treats vanished cost lines as negative deltas', () => {
    const out = diagnoseMargin(
      input({ models: [] }, { models: [model('openai', 'gpt-4o-mini', 25)] }),
    );
    expect(out.top_drivers?.[0]?.delta_usd).toBe(-25);
    expect(out.top_drivers?.[0]?.label).toBe('openai/gpt-4o-mini');
  });

  it('skips zero-delta lines', () => {
    const out = diagnoseMargin(
      input(
        { steps: [step('a', 1, 1)], models: [model('openai', 'gpt-4o', 5)] },
        { steps: [step('a', 1, 1)], models: [] },
      ),
    );
    // The step has 0 delta; the model is +5. Only the model surfaces.
    expect(out.top_drivers).toEqual([
      {
        kind: DriverKind.MODEL,
        label: 'openai/gpt-4o',
        delta_usd: 5,
        provider: 'openai',
        model: 'gpt-4o',
      },
    ]);
  });

  it('carries structured provider/model on slash-bearing model names', () => {
    const out = diagnoseMargin(
      input(
        { models: [model('together_ai', 'meta-llama/Llama-3', 100)] },
        { models: [model('together_ai', 'meta-llama/Llama-3', 50)] },
      ),
    );
    const driver = out.top_drivers?.[0];
    expect(driver?.kind).toBe(DriverKind.MODEL);
    expect(driver?.provider).toBe('together_ai');
    expect(driver?.model).toBe('meta-llama/Llama-3');
    expect(driver?.delta_usd).toBe(50);
  });

  it('does not collide on a step literally named "__null__"', () => {
    // Real customer steps won't actually contain a NUL byte but might
    // legitimately use "__null__" as a label — verify the sentinel
    // doesn't conflate them.
    const out = diagnoseMargin(
      input({ steps: [step('__null__', 5, 1), step(null, 3, 1)] }, { steps: [] }),
    );
    expect(out.top_drivers?.length).toBe(2);
  });
});

describe('diagnoseMargin — iteration inflation', () => {
  it('flags strict iteration growth on a known step', () => {
    const out = diagnoseMargin(
      input({ steps: [step('summarize', 5, 30)] }, { steps: [step('summarize', 5, 10)] }),
    );
    expect(out.iteration_inflation).toEqual({
      step_name: 'summarize',
      from: 10,
      to: 30,
    });
  });

  it('does not flag iteration drops', () => {
    const out = diagnoseMargin(
      input({ steps: [step('summarize', 5, 5)] }, { steps: [step('summarize', 5, 10)] }),
    );
    expect(out.iteration_inflation).toBeUndefined();
  });

  it('does not flag brand-new steps as inflation', () => {
    const out = diagnoseMargin(input({ steps: [step('new_step', 5, 100)] }, { steps: [] }));
    expect(out.iteration_inflation).toBeUndefined();
  });

  it('picks the step with the largest growth ratio', () => {
    const out = diagnoseMargin(
      input(
        {
          steps: [
            step('a', 1, 11), // ratio 11
            step('b', 1, 21), // ratio 21
            step('c', 1, 5), // ratio 5
          ],
        },
        {
          steps: [step('a', 1, 1), step('b', 1, 1), step('c', 1, 1)],
        },
      ),
    );
    expect(out.iteration_inflation?.step_name).toBe('b');
  });

  it('skips steps with null name', () => {
    const out = diagnoseMargin(
      input({ steps: [step(null, 5, 100)] }, { steps: [step(null, 5, 10)] }),
    );
    expect(out.iteration_inflation).toBeUndefined();
  });
});

describe('diagnoseMargin — insufficient revenue data', () => {
  it('flags insufficient_revenue_data when has_revenue_data=false', () => {
    const out = diagnoseMargin(input({}, {}, /* has_revenue_data */ false));
    expect(out.insufficient_revenue_data).toBe(true);
  });

  it('does not set the flag when revenue data is present', () => {
    const out = diagnoseMargin(input({}, {}, true));
    expect(out.insufficient_revenue_data).toBeUndefined();
  });
});
