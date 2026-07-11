import { describe, it, expect } from 'vitest';
import { Framework } from '@pylva/shared';
import { track, currentContext } from '../src/core/context.js';

describe('track() context propagation', () => {
  it('creates a context with trace_id / span_id / customer_id', async () => {
    const captured = await track('cust_1', async () => {
      return currentContext();
    });
    expect(captured?.customer_id).toBe('cust_1');
    expect(captured?.trace_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(captured?.span_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(captured?.parent_span_id).toBeNull();
  });

  it('nested track inherits trace_id + sets parent_span_id', async () => {
    const result = await track('cust_2', async () => {
      const outer = currentContext();
      const inner = await track('cust_2', async () => currentContext());
      return { outer, inner };
    });
    expect(result.inner?.trace_id).toBe(result.outer?.trace_id);
    expect(result.inner?.parent_span_id).toBe(result.outer?.span_id);
    expect(result.inner?.span_id).not.toBe(result.outer?.span_id);
  });

  it('supports options object (step)', async () => {
    const ctx = await track('cust_3', { step: 'answer_question' }, async () => currentContext());
    expect(ctx?.step_name).toBe('answer_question');
  });

  it('supports options object (framework) and nested inheritance', async () => {
    const result = await track('cust_3', { framework: Framework.LANGGRAPH }, async () => {
      const outer = currentContext();
      const inner = await track('cust_3', { step: 'answer_question' }, async () =>
        currentContext(),
      );
      return { outer, inner };
    });

    expect(result.outer?.framework).toBe(Framework.LANGGRAPH);
    expect(result.inner?.framework).toBe(Framework.LANGGRAPH);
    expect(result.inner?.step_name).toBe('answer_question');
  });

  it('async nested: child retains trace_id across awaits', async () => {
    const result = await track('cust_4', async () => {
      await new Promise((r) => setTimeout(r, 1));
      const ctx = currentContext();
      return ctx;
    });
    expect(result?.customer_id).toBe('cust_4');
  });
});
