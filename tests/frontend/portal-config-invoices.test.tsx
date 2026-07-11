// Regression: portal "Show invoices to end-users" toggle must default to OFF.
//
// D7 / migration 029 set `portal_configs.show_invoices` to default(false) —
// invoices are opt-in. Before this fix, PortalConfigClient defaulted the
// toggle to `true` when no config row existed yet, so a builder who opened
// portal settings to set branding / iframe origins and hit "Save config"
// would silently persist show_invoices=true and expose invoices to every
// portal customer. Lock the opt-in default at the render boundary.

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next/navigation.js', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

import { PortalConfigClient, type PortalConfigRow } from '@/components/settings/PortalConfigClient';

// Only show_invoices varies across cases; hold everything else constant so the
// assertion reads as "this input → this checkbox state".
function configWith(showInvoices: boolean): PortalConfigRow {
  return {
    company_name: 'Acme',
    logo_url: null,
    primary_color: null,
    cost_display_mode: 'usd',
    show_invoices: showInvoices,
    show_budget_progress: true,
    show_usage_trend: true,
    allowed_iframe_origins: [],
  };
}

function invoiceToggle(): HTMLInputElement {
  return screen.getByLabelText(/show invoices to end-users/i) as HTMLInputElement;
}

describe('<PortalConfigClient> — invoice visibility default (D7 opt-in)', () => {
  it('renders the invoice toggle UNCHECKED when no portal config exists yet', () => {
    render(<PortalConfigClient config={null} links={[]} canMutate />);
    expect(invoiceToggle().checked).toBe(false);
  });

  it('respects an explicit show_invoices=false from a saved config', () => {
    render(<PortalConfigClient config={configWith(false)} links={[]} canMutate />);
    expect(invoiceToggle().checked).toBe(false);
  });

  it('reflects an explicit opt-in (show_invoices=true) when the builder enabled it', () => {
    render(<PortalConfigClient config={configWith(true)} links={[]} canMutate />);
    expect(invoiceToggle().checked).toBe(true);
  });
});
