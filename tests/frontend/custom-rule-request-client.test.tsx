import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CustomRuleRequestClient } from '@/components/rules/CustomRuleRequestClient';

vi.mock('next/navigation.js', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('<CustomRuleRequestClient>', () => {
  it('shows the success screen after a 202 response', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, receipt_email_sent: true }), { status: 202 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<CustomRuleRequestClient slug="acme" />);

    fireEvent.change(screen.getByLabelText('What should this rule do?'), {
      target: {
        value: 'Alert us when one customer crosses an unusual hourly spend threshold.',
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Submit request' }));

    await waitFor(() => {
      expect(screen.getByText('Request received')).toBeInTheDocument();
    });
    expect(screen.getByText('Thanks for the idea.')).toBeInTheDocument();
  });

  it('renders the rate-limit message after a 429 response', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              message: 'Rate limit exceeded. Retry after 300 seconds.',
            },
          }),
          { status: 429 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<CustomRuleRequestClient slug="acme" />);

    fireEvent.change(screen.getByLabelText('What should this rule do?'), {
      target: {
        value: 'Alert us when one customer crosses an unusual hourly spend threshold.',
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Submit request' }));

    await waitFor(() => {
      expect(screen.getByText('Rate limit exceeded. Retry after 300 seconds.')).toBeInTheDocument();
    });
  });

  it('renders a generic error state after a 500 response', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    render(<CustomRuleRequestClient slug="acme" />);

    fireEvent.change(screen.getByLabelText('What should this rule do?'), {
      target: {
        value: 'Alert us when one customer crosses an unusual hourly spend threshold.',
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Submit request' }));

    await waitFor(() => {
      expect(screen.getByText('Could not send your request')).toBeInTheDocument();
    });
  });

  it('shows and enforces the 4000 character counter limit', () => {
    render(<CustomRuleRequestClient slug="acme" />);

    const textarea = screen.getByLabelText('What should this rule do?');
    expect(textarea).toHaveAttribute('maxlength', '4000');
    expect(screen.getByText('0/4000')).toBeInTheDocument();

    fireEvent.change(textarea, { target: { value: 'x'.repeat(4000) } });

    expect(screen.getByText('4000/4000')).toBeInTheDocument();
  });

  it('shows a visible error and re-enables submit when fetch rejects', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('offline');
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<CustomRuleRequestClient slug="acme" />);

    fireEvent.change(screen.getByLabelText('What should this rule do?'), {
      target: {
        value: 'Alert us when a customer has a sudden cost spike within a short window.',
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Submit request' }));

    expect(screen.getByRole('button', { name: 'Sending...' })).toBeDisabled();

    await waitFor(() => {
      expect(
        screen.getByText('Network error - please check your connection and try again.'),
      ).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Submit request' })).toBeEnabled();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/rules/custom-request',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
