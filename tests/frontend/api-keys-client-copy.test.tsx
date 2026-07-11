import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { COPY } from '@/lib/copy';

const { refreshMock, trackMock } = vi.hoisted(() => ({
  refreshMock: vi.fn(),
  trackMock: vi.fn(),
}));

vi.mock('next/navigation.js', () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

vi.mock('@/lib/analytics/events', () => ({
  track: trackMock,
}));

import { ApiKeysClient } from '@/components/settings/ApiKeysClient';

const fetchMock = vi.fn();
const writeText = vi.fn();

function mockCreateResponse(scope: string, plaintext: string) {
  fetchMock.mockResolvedValue(
    new Response(
      JSON.stringify({ key: { key_id: `${scope}-key`, plaintext, scope, label: null } }),
      { status: 201, headers: { 'Content-Type': 'application/json' } },
    ),
  );
}

describe('<ApiKeysClient> copy buttons', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    refreshMock.mockReset();
    trackMock.mockReset();
    writeText.mockReset().mockResolvedValue(undefined);
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('offers key + agent-prompt copy for a created universal key', async () => {
    mockCreateResponse('universal', 'pv_live_once_secret');

    render(<ApiKeysClient keys={[]} canMutate />);
    fireEvent.click(screen.getByRole('button', { name: 'Create API key' }));
    await screen.findByRole('dialog');

    expect(screen.getByRole('button', { name: COPY.api_key_copy })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: COPY.agent_prompt_copy_button }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: COPY.agent_prompt_copy_button }));
    await screen.findByRole('button', { name: COPY.agent_prompt_copy_done });
    expect(writeText.mock.calls[0]?.[0]).toContain('PYLVA_API_KEY=pv_live_once_secret');
    expect(JSON.stringify(trackMock.mock.calls)).not.toContain('pv_live_once_secret');
  });

  it('sends a scope-less create body', async () => {
    mockCreateResponse('universal', 'pv_live_once_secret');

    render(<ApiKeysClient keys={[]} canMutate />);
    fireEvent.click(screen.getByRole('button', { name: 'Create API key' }));
    await screen.findByRole('dialog');

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({});
  });

  it('clears the modal via Done', async () => {
    mockCreateResponse('universal', 'pv_live_once_secret');

    render(<ApiKeysClient keys={[]} canMutate />);
    fireEvent.click(screen.getByRole('button', { name: 'Create API key' }));
    await screen.findByRole('dialog');

    fireEvent.click(screen.getByRole('button', { name: COPY.api_key_done }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText('pv_live_once_secret')).not.toBeInTheDocument();
  });
});
