import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ErrorCode } from '@pylva/shared';
import { COPY } from '@/lib/copy';

const { refreshMock } = vi.hoisted(() => ({
  refreshMock: vi.fn(),
}));

vi.mock('next/navigation.js', () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

import { ApiKeysClient } from '@/components/settings/ApiKeysClient';

const fetchMock = vi.fn();
const PLAINTEXT = `pv_live_deadbeef_${'a'.repeat(32)}`;

function successResponse() {
  return new Response(
    JSON.stringify({
      key: { key_id: 'deadbeef', plaintext: PLAINTEXT, scope: 'universal', label: null },
    }),
    { status: 201, headers: { 'Content-Type': 'application/json' } },
  );
}

describe('<ApiKeysClient>', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    refreshMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the envelope message for a create failure without rendering the key dialog', async () => {
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

    render(<ApiKeysClient keys={[]} canMutate />);

    fireEvent.click(screen.getByRole('button', { name: 'Create API key' }));

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('sends only the label — no scope — in the create body', async () => {
    fetchMock.mockResolvedValue(successResponse());

    render(<ApiKeysClient keys={[]} canMutate />);
    fireEvent.change(screen.getByPlaceholderText('Label (optional)'), {
      target: { value: 'Prod' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create API key' }));

    await screen.findByRole('dialog');
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ label: 'Prod' });
  });

  it('opens the shown-once dialog with the key, capability statement, and warning', async () => {
    fetchMock.mockResolvedValue(successResponse());

    render(<ApiKeysClient keys={[]} canMutate />);
    fireEvent.click(screen.getByRole('button', { name: 'Create API key' }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(COPY.api_key_created_title);
    expect(dialog).toHaveTextContent(PLAINTEXT);
    expect(dialog).toHaveTextContent(COPY.api_key_capability);
    expect(dialog).toHaveTextContent(COPY.api_key_shown_once);
  });

  it('Done clears the plaintext from the DOM and refreshes the list', async () => {
    fetchMock.mockResolvedValue(successResponse());

    render(<ApiKeysClient keys={[]} canMutate />);
    fireEvent.click(screen.getByRole('button', { name: 'Create API key' }));

    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: COPY.api_key_done }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByText(PLAINTEXT)).not.toBeInTheDocument();
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it('Escape acts as Done; a backdrop click does not dismiss the key', async () => {
    fetchMock.mockResolvedValue(successResponse());

    render(<ApiKeysClient keys={[]} canMutate />);
    fireEvent.click(screen.getByRole('button', { name: 'Create API key' }));

    const dialog = await screen.findByRole('dialog');

    fireEvent.mouseDown(screen.getByTestId('dialog-backdrop'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(refreshMock).not.toHaveBeenCalled();

    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it('a double-click on Create sends exactly one request', async () => {
    let resolveFetch: (r: Response) => void = () => {};
    fetchMock.mockImplementation(
      () => new Promise<Response>((resolve) => (resolveFetch = resolve)),
    );

    render(<ApiKeysClient keys={[]} canMutate />);
    const button = screen.getByRole('button', { name: 'Create API key' });
    fireEvent.click(button);
    fireEvent.click(button);

    resolveFetch(successResponse());
    await screen.findByRole('dialog');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('renders read-only guidance for members', () => {
    render(<ApiKeysClient keys={[]} canMutate={false} />);

    expect(screen.getByText(COPY.api_key_member_view_only)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create API key' })).not.toBeInTheDocument();
  });
});
