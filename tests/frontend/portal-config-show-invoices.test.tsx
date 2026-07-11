// Regression: portal "Show invoices to end-users" toggle must honor the
// D7 / migration 036 contract — invoices are OPT-IN and default OFF.
//
// The bug: PortalConfigClient defaulted the toggle to `config?.show_invoices
// ?? true`. For a builder with no portal_configs row yet (config === null),
// the checkbox rendered CHECKED. Clicking "Save config" then persisted
// show_invoices=true — the exact inverse of the default-false consent the
// migration backfill enforces — exposing builder-confidential billing data to
// the end-user the moment portal invoice UI ships, with no explicit opt-in.
//
// These tests lock the default-off contract at the render boundary.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PortalConfigClient, type PortalConfigRow } from '@/components/settings/PortalConfigClient';

// The component calls useRouter() at render time (refresh() is only invoked
// inside event handlers, which these tests don't exercise).
vi.mock('next/navigation.js', () => ({
  useRouter: () => ({ refresh: () => {} }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

const INVOICE_LABEL = 'Show invoices to end-users';

function invoiceCheckbox(): HTMLInputElement {
  return screen.getByLabelText(INVOICE_LABEL) as HTMLInputElement;
}

const baseConfig: PortalConfigRow = {
  company_name: 'Acme',
  logo_url: null,
  primary_color: null,
  cost_display_mode: 'usd',
  show_invoices: false,
  show_budget_progress: true,
  show_usage_trend: true,
  allowed_iframe_origins: [],
};

describe('<PortalConfigClient> — show_invoices default', () => {
  it('defaults the invoices toggle to UNCHECKED when no config row exists', () => {
    render(<PortalConfigClient config={null} links={[]} canMutate />);
    expect(invoiceCheckbox().checked).toBe(false);
  });

  it('sends show_invoices=false when saving with no config row', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    render(<PortalConfigClient config={null} links={[]} canMutate />);
    fireEvent.click(screen.getByRole('button', { name: 'Save config' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/v1/portal/config',
        expect.objectContaining({ method: 'PUT' }),
      );
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.body).toEqual(expect.any(String));

    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body.show_invoices).toBe(false);
  });

  it('keeps the toggle UNCHECKED when the stored config has show_invoices=false', () => {
    render(
      <PortalConfigClient config={{ ...baseConfig, show_invoices: false }} links={[]} canMutate />,
    );
    expect(invoiceCheckbox().checked).toBe(false);
  });

  it('reflects an explicit opt-in (show_invoices=true → CHECKED)', () => {
    render(
      <PortalConfigClient config={{ ...baseConfig, show_invoices: true }} links={[]} canMutate />,
    );
    expect(invoiceCheckbox().checked).toBe(true);
  });
});
