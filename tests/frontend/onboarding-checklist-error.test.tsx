import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ErrorCode } from '@pylva/shared';
import { COPY } from '@/lib/copy';

const { trackMock } = vi.hoisted(() => ({
  trackMock: vi.fn(),
}));

vi.mock('@/lib/analytics/events', () => ({
  track: trackMock,
}));

import { OnboardingChecklist } from '@/components/dashboard/OnboardingChecklist';

const fetchMock = vi.fn();
const PLAINTEXT = `pv_live_deadbeef_${'b'.repeat(32)}`;

function successResponse() {
  return new Response(
    JSON.stringify({
      key: {
        key_id: 'deadbeef',
        plaintext: PLAINTEXT,
        scope: 'universal',
        label: 'Quickstart key',
      },
    }),
    { status: 201, headers: { 'Content-Type': 'application/json' } },
  );
}

describe('<OnboardingChecklist> API key creation', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    trackMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the backend error envelope message verbatim', async () => {
    const message =
      'The database schema is out of date — a pending migration must be applied. Check /api/v1/health schema status, then run pnpm db:migrate.';
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            type: 'api_error',
            code: ErrorCode.INTERNAL_ERROR,
            message,
          },
        }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    render(<OnboardingChecklist slug="acme" isOwner />);

    fireEvent.click(screen.getByRole('button', { name: 'Create API key' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
  });

  it('falls back to the generic message when the error body is not JSON', async () => {
    fetchMock.mockResolvedValue(new Response('not json', { status: 500 }));

    render(<OnboardingChecklist slug="acme" isOwner />);

    fireEvent.click(screen.getByRole('button', { name: 'Create API key' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Failed to create key (500). Try again.',
    );
  });

  it('sends a scope-less body and opens the shown-once dialog on success', async () => {
    fetchMock.mockResolvedValue(successResponse());

    render(<OnboardingChecklist slug="acme" isOwner />);

    fireEvent.click(screen.getByRole('button', { name: 'Create API key' }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(COPY.api_key_created_title);
    expect(dialog).toHaveTextContent(PLAINTEXT);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ label: 'Quickstart key' });
    expect(trackMock).toHaveBeenCalledWith('api_key_create_started', { surface: 'app' });
    expect(trackMock).toHaveBeenCalledWith('api_key_created', { surface: 'app', is_owner: true });
  });

  it('renders a persistent completed state after Done — the Create button does not re-arm', async () => {
    fetchMock.mockResolvedValue(successResponse());

    render(<OnboardingChecklist slug="acme" isOwner />);

    fireEvent.click(screen.getByRole('button', { name: 'Create API key' }));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: COPY.api_key_done }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByText(PLAINTEXT)).not.toBeInTheDocument();
    expect(screen.getByText(/Key created/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create API key' })).not.toBeInTheDocument();
  });

  it('shows read-only guidance for non-owners', () => {
    render(<OnboardingChecklist slug="acme" isOwner={false} />);

    expect(screen.getByText(/Ask a workspace owner to create an API key/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create API key' })).not.toBeInTheDocument();
  });
});
