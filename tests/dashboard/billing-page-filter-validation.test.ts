import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { ReactNode } from 'react';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const mocks = vi.hoisted(() => ({
  eqCalls: [] as Array<{ column: string; value: unknown }>,
  offsetCalls: [] as number[],
  withRLS: vi.fn(),
  listRows: [] as Array<Record<string, unknown>>,
  countRows: [{ c: 0 }],
  PageHeader: () => null,
  DraftBanner: () => null,
  UnpricedBanner: ({ children }: { children: ReactNode }) => children,
}));

vi.mock('drizzle-orm', () => ({
  and: (...conditions: unknown[]) => ({ op: 'and', conditions }),
  count: () => ({ op: 'count' }),
  desc: (column: unknown) => ({ op: 'desc', column }),
  eq: (column: string, value: unknown) => {
    mocks.eqCalls.push({ column, value });
    return { op: 'eq', column, value };
  },
}));

vi.mock('@/lib/dashboard/headers', () => ({
  readDashboardHeaders: async () => ({
    builderId: '00000000-0000-0000-0000-000000000001',
    role: 'owner',
    userId: 'user-1',
  }),
}));

vi.mock('@/lib/db/schema', () => ({
  invoices: {
    id: 'id',
    builder_id: 'builder_id',
    customer_id: 'customer_id',
    billing_cycle_id: 'billing_cycle_id',
    status: 'status',
    has_unpriced_events: 'has_unpriced_events',
    created_at: 'created_at',
    period_start: 'period_start',
  },
}));

vi.mock('@/lib/db/rls', () => ({
  withRLS: mocks.withRLS,
}));

vi.mock('@/components/dashboard/DraftBanner', () => ({
  DraftBanner: mocks.DraftBanner,
}));

vi.mock('@/components/billing/UnpricedBanner', () => ({
  UnpricedBanner: mocks.UnpricedBanner,
}));

vi.mock('@/components/dashboard/PageHeader', () => ({
  PageHeader: mocks.PageHeader,
}));

vi.mock('@/lib/formatting', () => ({
  formatUsd: (value: unknown) => `$${value}`,
}));

const { default: BillingListPage } =
  await import('../../src/app/o/[slug]/dashboard/billing/page.js');

function textContent(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textContent).join('');
  if (typeof node === 'object' && 'props' in node) {
    return textContent((node as { props?: { children?: unknown } }).props?.children);
  }
  return '';
}

function makeTx() {
  return {
    select: (shape?: Record<string, unknown>) => {
      const isCountQuery = Boolean(shape && 'c' in shape);
      const chain = {
        from: () => chain,
        where: () => chain,
        orderBy: () => chain,
        limit: () => chain,
        offset: (offset: number) => {
          mocks.offsetCalls.push(offset);
          return Promise.resolve(mocks.listRows);
        },
        then: (
          onFulfilled?: (value: unknown[]) => unknown,
          onRejected?: (reason: unknown) => unknown,
        ) =>
          Promise.resolve(isCountQuery ? mocks.countRows : mocks.listRows).then(
            onFulfilled,
            onRejected,
          ),
      };
      return chain;
    },
  };
}

function pageProps(searchParams: Record<string, string | undefined> = {}) {
  return {
    params: Promise.resolve({ slug: 'pylva-test' }),
    searchParams: Promise.resolve(searchParams),
  };
}

describe('/o/[slug]/dashboard/billing filter validation', () => {
  beforeEach(() => {
    mocks.eqCalls.length = 0;
    mocks.offsetCalls.length = 0;
    mocks.listRows = [];
    mocks.countRows = [{ c: 0 }];
    mocks.withRLS.mockReset();
    mocks.withRLS.mockImplementation(async (_builderId: string, cb: (tx: unknown) => unknown) =>
      cb(makeTx()),
    );
  });

  it('renders an empty state for a malformed cycle filter without querying the UUID column', async () => {
    const element = await BillingListPage(pageProps({ cycle: 'xfngg' }));

    expect(textContent(element)).toContain('No invoices match these filters yet.');
    expect(mocks.withRLS).toHaveBeenCalledTimes(2);
    expect(mocks.offsetCalls).toEqual([]);
    expect(mocks.eqCalls).not.toContainEqual({ column: 'billing_cycle_id', value: 'xfngg' });
  });

  it('renders an empty state for a malformed customer_id filter without querying the UUID column', async () => {
    const element = await BillingListPage(pageProps({ customer_id: 'not-a-uuid' }));

    expect(textContent(element)).toContain('No invoices match these filters yet.');
    expect(mocks.withRLS).toHaveBeenCalledTimes(2);
    expect(mocks.offsetCalls).toEqual([]);
    expect(mocks.eqCalls).not.toContainEqual({ column: 'customer_id', value: 'not-a-uuid' });
  });

  it('renders an empty state for an invalid status filter without querying status', async () => {
    const element = await BillingListPage(pageProps({ status: 'refunded' }));

    expect(textContent(element)).toContain('No invoices match these filters yet.');
    expect(mocks.withRLS).toHaveBeenCalledTimes(2);
    expect(mocks.offsetCalls).toEqual([]);
    expect(mocks.eqCalls).not.toContainEqual({ column: 'status', value: 'refunded' });
  });

  it('normalizes a malformed offset to zero on otherwise valid filters', async () => {
    await BillingListPage(pageProps({ offset: 'wat' }));

    expect(mocks.withRLS).toHaveBeenCalledTimes(3);
    expect(mocks.offsetCalls).toEqual([0]);
  });

  it('passes valid filters to the invoice query', async () => {
    const customerId = '11111111-1111-1111-1111-111111111111';
    const cycleId = '22222222-2222-2222-2222-222222222222';

    await BillingListPage(
      pageProps({
        status: 'draft',
        customer_id: customerId,
        cycle: cycleId,
        offset: '17',
      }),
    );

    expect(mocks.withRLS).toHaveBeenCalledTimes(3);
    expect(mocks.offsetCalls).toEqual([17]);
    expect(mocks.eqCalls).toContainEqual({ column: 'status', value: 'draft' });
    expect(mocks.eqCalls).toContainEqual({ column: 'customer_id', value: customerId });
    expect(mocks.eqCalls).toContainEqual({ column: 'billing_cycle_id', value: cycleId });
  });
});
