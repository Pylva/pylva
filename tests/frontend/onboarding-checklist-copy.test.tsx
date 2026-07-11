import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const { trackMock } = vi.hoisted(() => ({
  trackMock: vi.fn(),
}));

vi.mock('@/lib/analytics/events', () => ({
  track: trackMock,
}));

import { OnboardingChecklist } from '@/components/dashboard/OnboardingChecklist';
import { AGENT_SETUP_GUIDE_URL } from '@/lib/sdk-snippets';
import { COPY } from '@/lib/copy';

const PLAINTEXT = 'pv_live_once_secret';

const fetchMock = vi.fn();
const writeText = vi.fn();

async function renderWithCreatedKey() {
  fetchMock.mockResolvedValue(
    new Response(
      JSON.stringify({
        key: {
          key_id: 'universal-key',
          plaintext: PLAINTEXT,
          scope: 'universal',
          label: 'Quickstart key',
        },
      }),
      { status: 201, headers: { 'Content-Type': 'application/json' } },
    ),
  );

  render(<OnboardingChecklist slug="acme" isOwner />);
  fireEvent.click(screen.getByRole('button', { name: 'Create API key' }));
  await screen.findByRole('dialog');
}

describe('<OnboardingChecklist> copy buttons', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    trackMock.mockReset();
    writeText.mockReset().mockResolvedValue(undefined);
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('offers both copy buttons and the agent hint after key creation', async () => {
    await renderWithCreatedKey();

    expect(screen.getByRole('button', { name: COPY.api_key_copy })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: COPY.agent_prompt_copy_button }),
    ).toBeInTheDocument();
    expect(screen.getByText(/another coding agent\?/)).toBeInTheDocument();
  });

  it('copies exactly the plaintext key', async () => {
    await renderWithCreatedKey();

    fireEvent.click(screen.getByRole('button', { name: COPY.api_key_copy }));

    expect(await screen.findByRole('button', { name: COPY.api_key_copied })).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith(PLAINTEXT);
    expect(trackMock).toHaveBeenCalledWith('api_key_copied', { surface: 'onboarding' });
  });

  it('copies a prompt containing the setup guide URL and the key line', async () => {
    await renderWithCreatedKey();

    fireEvent.click(screen.getByRole('button', { name: COPY.agent_prompt_copy_button }));

    expect(
      await screen.findByRole('button', { name: COPY.agent_prompt_copy_done }),
    ).toBeInTheDocument();
    const prompt = writeText.mock.calls[0]?.[0] as string;
    expect(prompt).toContain(AGENT_SETUP_GUIDE_URL);
    expect(prompt).toContain(`PYLVA_API_KEY=${PLAINTEXT}`);
    expect(prompt).toContain('Never print, log, or commit the API key.');
    expect(trackMock).toHaveBeenCalledWith('agent_prompt_copied', { surface: 'onboarding' });
  });

  it('never passes the plaintext key to analytics', async () => {
    await renderWithCreatedKey();

    fireEvent.click(screen.getByRole('button', { name: COPY.api_key_copy }));
    fireEvent.click(screen.getByRole('button', { name: COPY.agent_prompt_copy_button }));
    await screen.findByRole('button', { name: COPY.agent_prompt_copy_done });

    expect(JSON.stringify(trackMock.mock.calls)).not.toContain(PLAINTEXT);
  });
});
