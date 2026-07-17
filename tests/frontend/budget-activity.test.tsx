import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { BudgetActivityExplorer } from '@/components/budget-activity/BudgetActivityExplorer';
import { BudgetActivityPanel } from '@/components/budget-activity/BudgetActivityPanel';
import {
  budgetAccountState,
  budgetActivity,
  budgetActivityPage,
} from '../_helpers/budget-activity-fixtures';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock('@/lib/dashboard/api-client', () => ({ apiFetch: mocks.apiFetch }));

describe('<BudgetActivityExplorer>', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState(null, '', '/o/acme/dashboard/budget-activity');
  });

  it('renders refusal proof, every budget amount, non-color cues, and responsive layouts', () => {
    const { container } = render(<BudgetActivityExplorer initial={budgetActivityPage()} />);

    const mobileSurface = container.querySelector('ul.md\\:hidden');
    expect(mobileSurface).not.toBeNull();
    const mobile = within(mobileSurface as HTMLElement);
    const mobileProof = mobile.getByLabelText('Budget proof for openai / gpt-4o-mini');
    const expectMobileDatum = (label: string, value: string) => {
      const datum = within(mobileProof).getByText(label, { exact: true }).parentElement;
      expect(datum).not.toBeNull();
      expect(within(datum as HTMLElement).getByText(value, { exact: true })).toBeInTheDocument();
    };

    expect(screen.getAllByLabelText('Budget status: Refused').length).toBeGreaterThan(0);
    expect(screen.getAllByText('⊘ Not sent').length).toBeGreaterThan(0);
    expect(screen.getAllByText('$0.0000042').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/committed before \$0\.74/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/reserved before \$0\.01/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/unresolved before \$0\.00/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/remaining \$0\.00 of \$0\.75/).length).toBeGreaterThan(0);
    expect(screen.getByText('Authority: PostgreSQL · 1 actions')).toBeInTheDocument();
    expect(container.querySelector('.hidden.md\\:block')).not.toBeNull();
    expect(mobile.getByLabelText('Budget status: Refused')).toHaveTextContent('⊘Refused');
    expectMobileDatum('Requested', '$0.0000042');
    expectMobileDatum('Actual', '$0.00');
    expectMobileDatum('Committed before', '$0.74');
    expectMobileDatum('Reserved before', '$0.01');
    expectMobileDatum('Unresolved before', '$0.00');
    expectMobileDatum('Remaining', '$0.00');
    expectMobileDatum('Provider', '⊘ Not sent');
  });

  it('applies keyboard-native filters through the authenticated dashboard client', async () => {
    const filtered = budgetActivityPage([budgetActivity({ status: 'charged' })]);
    filtered.filters = { ...filtered.filters, status: 'charged', customer: 'end_user_42' };
    mocks.apiFetch.mockResolvedValue(
      new Response(JSON.stringify(filtered), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    render(<BudgetActivityExplorer initial={budgetActivityPage()} />);

    const status = screen.getByLabelText('Status');
    status.focus();
    expect(status).toHaveFocus();
    fireEvent.change(status, { target: { value: 'charged' } });
    fireEvent.change(screen.getByLabelText('End-user ID'), {
      target: { value: 'end_user_42' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));

    await waitFor(() =>
      expect(mocks.apiFetch).toHaveBeenCalledWith(
        expect.stringMatching(
          /^\/api\/v1\/budget-activity\?.*status=charged.*customer=end_user_42/,
        ),
        expect.objectContaining({ method: 'GET', credentials: 'include' }),
      ),
    );
    expect(await screen.findAllByLabelText('Budget status: Charged')).not.toHaveLength(0);
  });

  it('exposes loading, pagination, and recoverable error states', async () => {
    const first = budgetActivityPage();
    first.pagination = { page: 1, page_size: 25, total: 26, total_pages: 2 };
    let resolveRequest: ((response: Response) => void) | undefined;
    mocks.apiFetch.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveRequest = resolve;
      }),
    );
    render(<BudgetActivityExplorer initial={first} />);

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('status')).toHaveTextContent('Loading budget activity');

    const failed = new Response(
      JSON.stringify({ error: { message: 'Budget activity is temporarily unavailable' } }),
      { status: 503, headers: { 'content-type': 'application/json' } },
    );
    resolveRequest?.(failed);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Budget activity is temporarily unavailable',
    );

    mocks.apiFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(first), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('renders an intentional empty state', () => {
    render(<BudgetActivityExplorer initial={budgetActivityPage([])} />);
    expect(screen.getByText('No control actions match these filters.')).toBeInTheDocument();
    expect(screen.getByText(/stay out of spend, event totals/i)).toBeInTheDocument();
  });
});

describe('<BudgetActivityPanel>', () => {
  it('makes a blocked-only end-user visible without inventing spend', () => {
    render(
      <BudgetActivityPanel
        activities={[budgetActivity()]}
        accounts={[budgetAccountState()]}
        slug="acme"
        title="End-user budget control"
      />,
    );
    expect(screen.getByRole('heading', { name: 'End-user budget control' })).toBeInTheDocument();
    expect(screen.getByText('⊘ provider not sent')).toBeInTheDocument();
    expect(screen.getByText('$0.0000042')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /trace eeeeeeee/i })).toHaveAttribute(
      'href',
      '/o/acme/dashboard/traces/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    );
  });
});
