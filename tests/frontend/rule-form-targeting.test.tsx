import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const routerMocks = vi.hoisted(() => ({
  back: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock('next/navigation.js', () => ({
  useRouter: () => routerMocks,
}));

import { RuleFormClient } from '@/components/rules/RuleFormClient';

const CHOOSE_END_USER_ERROR = 'Choose an end-user from the list.';
const NON_BUDGET_TYPES = ['cost_threshold', 'margin_protection'] as const;
const ALL_TYPES = ['budget_limit', 'cost_threshold', 'margin_protection'] as const;

interface CustomerOption {
  id: string;
  external_id: string;
  name: string | null;
  email: string | null;
}

const CUSTOMER_OPTIONS: CustomerOption[] = [
  {
    id: 'customer-alpha',
    external_id: 'alpha',
    name: 'Alpha Co',
    email: 'alpha@example.com',
  },
  {
    id: 'customer-beta',
    external_id: 'beta',
    name: 'Beta Labs',
    email: 'beta@example.com',
  },
];

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function mockCreateRule() {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ rule: { id: 'rule_1' } })));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function mockRuleAndCustomerFetch(customers: readonly CustomerOption[] = CUSTOMER_OPTIONS) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('/api/v1/customers/search')) {
      const parsed = new URL(url, 'http://localhost');
      const query = (parsed.searchParams.get('search') ?? '').toLowerCase();
      const filtered = customers.filter((customer) =>
        [customer.external_id, customer.name, customer.email]
          .some((value) => value?.toLowerCase().includes(query) ?? false),
      );
      return new Response(
        JSON.stringify({ customers: filtered, limit: 500, has_more: false }),
      );
    }
    if (url === '/api/v1/rules') {
      return new Response(JSON.stringify({ rule: { id: 'rule_1' } }));
    }
    throw new Error(`Unexpected fetch ${url} ${init?.method ?? 'GET'}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function submitForm() {
  const button = screen.getByRole('button', { name: 'Create rule' });
  const form = button.closest('form');
  if (!form) throw new Error('Rule form not found');
  fireEvent.submit(form);
}

function rulePostCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(([input]) => String(input) === '/api/v1/rules');
}

function lastRuleRequestBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const init = rulePostCalls(fetchMock).at(-1)?.[1] as RequestInit | undefined;
  if (!init?.body) throw new Error('Missing request body');
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

async function switchToOneEndUserMode() {
  fireEvent.change(screen.getByLabelText('Applies to'), { target: { value: 'one' } });
  await screen.findByRole('combobox', { name: 'End-user' });
}

describe('<RuleFormClient> targeting UX', () => {
  it.each(ALL_TYPES)('submits a valid %s payload with default template config', async (type) => {
    const fetchMock = mockCreateRule();
    render(<RuleFormClient type={type} />);

    submitForm();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/v1/rules', expect.anything()));

    const body = lastRuleRequestBody(fetchMock);
    expect(body).toMatchObject({
      type,
      enabled: true,
      customer_id: null,
    });
    if (type === 'budget_limit') {
      expect(body.config).toMatchObject({
        limit_usd: 50,
        period: 'day',
        hard_stop: true,
        scope: 'per_customer',
      });
    } else if (type === 'cost_threshold') {
      expect(body.config).toMatchObject({
        threshold_usd: 25,
        period: 'day',
        scope: 'per_customer',
      });
    } else {
      expect(body.config).toMatchObject({
        margin_threshold_pct: 15,
        period: 'day',
        scope: 'per_customer',
      });
    }
  });

  it('allows a break-even margin threshold', async () => {
    const fetchMock = mockCreateRule();
    render(<RuleFormClient type="margin_protection" />);

    const thresholdInput = screen.getByDisplayValue('15');
    expect(thresholdInput).toHaveAttribute('min', '0');
    expect(thresholdInput).toHaveAttribute('step', '1');

    fireEvent.change(thresholdInput, { target: { value: '0' } });
    submitForm();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/v1/rules', expect.anything()));
    expect(lastRuleRequestBody(fetchMock).config).toMatchObject({ margin_threshold_pct: 0 });
  });

  it('renders a server field error inline after submit', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              message: 'Threshold must be greater than 0',
              param: 'config.threshold_usd',
            },
          }),
          { status: 400 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<RuleFormClient type="cost_threshold" />);
    submitForm();

    await waitFor(() => {
      expect(screen.getByText('Threshold must be greater than 0')).toBeInTheDocument();
    });
  });

  it('disables the submit button while a request is pending', async () => {
    let resolveFetch!: (response: Response) => void;
    const pendingFetch = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const fetchMock = vi.fn(() => pendingFetch);
    vi.stubGlobal('fetch', fetchMock);

    render(<RuleFormClient type="cost_threshold" />);
    submitForm();

    expect(screen.getByRole('button', { name: 'Creating…' })).toBeDisabled();

    resolveFetch(new Response(JSON.stringify({ rule: { id: 'rule_1' } })));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create rule' })).toBeEnabled());
  });

  it('defaults to all end-users with a disabled empty end-user input and separate budget pool', () => {
    render(<RuleFormClient type="budget_limit" />);

    expect(screen.getByLabelText('Applies to')).toHaveValue('all');

    const customerInput = screen.getByLabelText('End-user');
    expect(customerInput).toBeDisabled();
    expect(customerInput).toHaveValue('');

    expect(screen.getByLabelText('Budget pool')).toHaveValue('per_customer');
  });

  it('enables and requires selecting a listed end-user when targeting one end-user', async () => {
    const fetchMock = mockRuleAndCustomerFetch();
    render(<RuleFormClient type="budget_limit" />);

    await switchToOneEndUserMode();

    const customerInput = screen.getByLabelText('End-user');
    expect(customerInput).toBeEnabled();
    expect(customerInput).toBeRequired();
    await screen.findByRole('option', { name: /Alpha Co.*alpha/ });
    expect(screen.queryByLabelText('Budget pool')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create rule' })).toBeDisabled();

    submitForm();

    expect(rulePostCalls(fetchMock)).toHaveLength(0);
    expect(screen.getByText(CHOOSE_END_USER_ERROR)).toBeInTheDocument();
  });

  it('clears and disables the end-user input when switching back to all end-users', async () => {
    mockRuleAndCustomerFetch();
    render(<RuleFormClient type="budget_limit" />);

    await switchToOneEndUserMode();
    fireEvent.click(await screen.findByRole('option', { name: /Alpha Co.*alpha/ }));
    expect(screen.getByLabelText('End-user')).toHaveValue('Alpha Co (alpha)');

    fireEvent.change(screen.getByLabelText('Applies to'), { target: { value: 'all' } });

    const customerInput = screen.getByLabelText('End-user');
    expect(customerInput).toBeDisabled();
    expect(customerInput).toHaveValue('');
    expect(screen.getByLabelText('Budget pool')).toHaveValue('per_customer');
  });

  it('restores the previous all-end-user budget pool after visiting one-end-user mode', async () => {
    mockRuleAndCustomerFetch();
    render(<RuleFormClient type="budget_limit" />);

    fireEvent.change(screen.getByLabelText('Budget pool'), { target: { value: 'pooled' } });
    expect(screen.getByLabelText('Budget pool')).toHaveValue('pooled');

    await switchToOneEndUserMode();
    expect(screen.queryByLabelText('Budget pool')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Applies to'), { target: { value: 'all' } });

    expect(screen.getByLabelText('Budget pool')).toHaveValue('pooled');
  });

  it('clears one-end-user validation errors when targeting mode changes', async () => {
    const fetchMock = mockRuleAndCustomerFetch();
    render(<RuleFormClient type="budget_limit" />);

    await switchToOneEndUserMode();
    submitForm();

    expect(rulePostCalls(fetchMock)).toHaveLength(0);
    expect(screen.getByText(CHOOSE_END_USER_ERROR)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Applies to'), { target: { value: 'all' } });

    expect(screen.queryByText(CHOOSE_END_USER_ERROR)).not.toBeInTheDocument();
  });

  it('submits one end-user with a forced per-customer scope', async () => {
    const fetchMock = mockRuleAndCustomerFetch();
    render(<RuleFormClient type="budget_limit" />);

    fireEvent.change(screen.getByLabelText('Budget pool'), { target: { value: 'pooled' } });
    await switchToOneEndUserMode();
    fireEvent.change(screen.getByLabelText('End-user'), { target: { value: 'alp' } });
    fireEvent.click(await screen.findByRole('option', { name: /Alpha Co.*alpha/ }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input]) => String(input).includes('search=Alpha')),
      ).toBe(true),
    );
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    submitForm();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/v1/rules', expect.anything()));

    const body = lastRuleRequestBody(fetchMock);
    expect(body.customer_id).toBe('alpha');
    expect(body.config).toMatchObject({ scope: 'per_customer' });
  });

  it('narrows listed end-users while typing', async () => {
    mockRuleAndCustomerFetch();
    render(<RuleFormClient type="budget_limit" />);

    await switchToOneEndUserMode();
    expect(await screen.findByRole('option', { name: /Alpha Co.*alpha/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Beta Labs.*beta/ })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('End-user'), { target: { value: 'bet' } });

    expect(await screen.findByRole('option', { name: /Beta Labs.*beta/ })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('option', { name: /Alpha Co.*alpha/ })).not.toBeInTheDocument(),
    );
  });

  it('shows external IDs and emails to disambiguate duplicate names', async () => {
    mockRuleAndCustomerFetch([
      {
        id: 'customer-acme-1',
        external_id: 'acme_us',
        name: 'Acme',
        email: 'us@example.com',
      },
      {
        id: 'customer-acme-2',
        external_id: 'acme_eu',
        name: 'Acme',
        email: 'eu@example.com',
      },
    ]);
    render(<RuleFormClient type="budget_limit" />);

    await switchToOneEndUserMode();

    const options = await screen.findAllByRole('option', { name: /Acme/ });
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveTextContent('acme_us');
    expect(options[0]).toHaveTextContent('us@example.com');
    expect(options[1]).toHaveTextContent('acme_eu');
    expect(options[1]).toHaveTextContent('eu@example.com');
  });

  it('clears the selected end-user when the selected text is edited', async () => {
    mockRuleAndCustomerFetch();
    render(<RuleFormClient type="budget_limit" />);

    await switchToOneEndUserMode();
    fireEvent.click(await screen.findByRole('option', { name: /Alpha Co.*alpha/ }));
    expect(screen.getByRole('button', { name: 'Create rule' })).toBeEnabled();

    fireEvent.change(screen.getByLabelText('End-user'), { target: { value: 'Alpha Co edited' } });

    expect(await screen.findByText('No matching end-users')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create rule' })).toBeDisabled();
    submitForm();
    expect(screen.getByText(CHOOSE_END_USER_ERROR)).toBeInTheDocument();
  });

  it('shows a load error and blocks creation when end-user search fails', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/v1/customers/search')) {
        return new Response(JSON.stringify({ error: { message: 'search failed' } }), {
          status: 500,
        });
      }
      return new Response(JSON.stringify({ rule: { id: 'rule_1' } }));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<RuleFormClient type="budget_limit" />);

    await switchToOneEndUserMode();

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load end-users.');
    expect(screen.getByRole('button', { name: 'Create rule' })).toBeDisabled();
    submitForm();
    expect(rulePostCalls(fetchMock)).toHaveLength(0);
  });

  it('shows an empty state and blocks creation when no end-users match', async () => {
    const fetchMock = mockRuleAndCustomerFetch([]);
    render(<RuleFormClient type="budget_limit" />);

    await switchToOneEndUserMode();

    expect(await screen.findByText('No matching end-users')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create rule' })).toBeDisabled();
    submitForm();
    expect(rulePostCalls(fetchMock)).toHaveLength(0);
  });

  it('ignores stale customer search responses', async () => {
    let resolveA!: (response: Response) => void;
    let resolveAl!: (response: Response) => void;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/v1/rules') {
        return new Response(JSON.stringify({ rule: { id: 'rule_1' } }));
      }
      const parsed = new URL(url, 'http://localhost');
      const query = parsed.searchParams.get('search') ?? '';
      if (query === 'a') {
        return new Promise<Response>((resolve) => {
          resolveA = resolve;
        });
      }
      if (query === 'al') {
        return new Promise<Response>((resolve) => {
          resolveAl = resolve;
        });
      }
      return new Response(JSON.stringify({ customers: [], limit: 500, has_more: false }));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<RuleFormClient type="budget_limit" />);

    await switchToOneEndUserMode();
    fireEvent.change(screen.getByLabelText('End-user'), { target: { value: 'a' } });
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([input]) => String(input).includes('search=a'))).toBe(true),
    );
    fireEvent.change(screen.getByLabelText('End-user'), { target: { value: 'al' } });
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([input]) => String(input).includes('search=al'))).toBe(
        true,
      ),
    );

    resolveAl(
      new Response(
        JSON.stringify({
          customers: [CUSTOMER_OPTIONS[0]],
          limit: 500,
          has_more: false,
        }),
      ),
    );
    expect(await screen.findByRole('option', { name: /Alpha Co.*alpha/ })).toBeInTheDocument();

    resolveA(
      new Response(
        JSON.stringify({
          customers: [CUSTOMER_OPTIONS[1]],
          limit: 500,
          has_more: false,
        }),
      ),
    );

    await waitFor(() =>
      expect(screen.queryByRole('option', { name: /Beta Labs.*beta/ })).not.toBeInTheDocument(),
    );
  });

  it('submits all end-users with a shared budget pool', async () => {
    const fetchMock = mockCreateRule();
    render(<RuleFormClient type="budget_limit" />);

    fireEvent.change(screen.getByLabelText('Budget pool'), { target: { value: 'pooled' } });
    submitForm();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/v1/rules', expect.anything()));

    const body = lastRuleRequestBody(fetchMock);
    expect(body.customer_id).toBeNull();
    expect(body.config).toMatchObject({ scope: 'pooled' });
  });

  it.each(NON_BUDGET_TYPES)(
    'keeps top-level budget pool targeting behavior for %s rules',
    async (type) => {
      const fetchMock = mockRuleAndCustomerFetch();
      render(<RuleFormClient type={type} />);

      expect(screen.getByLabelText('Budget pool')).toHaveValue('per_customer');

      fireEvent.change(screen.getByLabelText('Applies to'), { target: { value: 'one' } });
      expect(screen.queryByLabelText('Budget pool')).not.toBeInTheDocument();

      fireEvent.change(screen.getByLabelText('End-user'), { target: { value: 'acme-corp' } });
      fireEvent.change(screen.getByLabelText('Applies to'), { target: { value: 'all' } });
      fireEvent.change(screen.getByLabelText('Budget pool'), { target: { value: 'pooled' } });
      submitForm();

      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith('/api/v1/rules', expect.anything()),
      );

      const body = lastRuleRequestBody(fetchMock);
      expect(body.type).toBe(type);
      expect(body.customer_id).toBeNull();
      expect(body.config).toMatchObject({ scope: 'pooled' });
    },
  );
});
