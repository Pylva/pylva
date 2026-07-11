import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn(), refresh: vi.fn() }));

vi.mock('@/lib/dashboard/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));

const { DashboardActionButton } = await import('@/components/dashboard/DashboardActionButton');
const { DashboardDownloadLink } = await import('@/components/dashboard/DashboardDownloadLink');

describe('context-aware dashboard actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.apiFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });

  it('runs mutations through apiFetch and refreshes the current RSC page', async () => {
    render(
      <DashboardActionButton
        endpoint="/api/v1/billing/disconnect"
        label="Disconnect Stripe"
        className="button"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Stripe' }));

    await waitFor(() => {
      expect(mocks.apiFetch).toHaveBeenCalledWith('/api/v1/billing/disconnect', {
        method: 'POST',
      });
      expect(mocks.refresh).toHaveBeenCalledTimes(1);
    });
  });

  it('surfaces mutation failures without navigating to raw JSON', async () => {
    mocks.apiFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Session changed' } }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }),
    );
    render(<DashboardActionButton endpoint="/api/v1/action" label="Run" className="button" />);

    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    expect(await screen.findByText('Session changed')).toBeInTheDocument();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('downloads CSV through apiFetch so selector mismatches reach SessionWatcher', async () => {
    mocks.apiFetch.mockResolvedValue(new Response('a,b\n1,2', { status: 200 }));
    const createObjectURL = vi.fn(() => 'blob:test');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL }));
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    render(<DashboardDownloadLink href="/api/v1/export/csv">Export CSV</DashboardDownloadLink>);

    fireEvent.click(screen.getByRole('link', { name: 'Export CSV' }));

    await waitFor(() => {
      expect(mocks.apiFetch).toHaveBeenCalledWith('/api/v1/export/csv');
      expect(createObjectURL).toHaveBeenCalledTimes(1);
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:test');
    });
    click.mockRestore();
    vi.unstubAllGlobals();
  });
});
