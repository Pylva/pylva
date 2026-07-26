import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ErrorCode } from '@pylva/shared';

const { refreshMock } = vi.hoisted(() => ({
  refreshMock: vi.fn(),
}));

vi.mock('next/navigation.js', () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

import { WebhooksClient } from '@/components/settings/WebhooksClient';

const fetchMock = vi.fn();

describe('<WebhooksClient> feature gate denial UX', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    refreshMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the settings surface visible when workspace access is restricted', async () => {
    const deniedMessage = 'Workspace access is suspended; reactivate billing to continue';
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            type: 'invalid_request_error',
            code: ErrorCode.FEATURE_NOT_AVAILABLE,
            message: deniedMessage,
          },
        }),
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    render(<WebhooksClient webhooks={[]} canMutate />);

    expect(screen.getByText('New webhook')).toBeInTheDocument();
    expect(screen.getByText('Webhooks (0)')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('https://hooks.example.com/pylva'), {
      target: { value: 'https://hooks.example.com/pylva' },
    });
    fireEvent.change(screen.getByPlaceholderText('rule.fired, margin.alert, ...'), {
      target: { value: 'rule.fired' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(await screen.findByText(deniedMessage)).toBeInTheDocument();
    expect(screen.getByText('Webhooks (0)')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('https://hooks.example.com/pylva')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/settings/webhooks',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(refreshMock).not.toHaveBeenCalled();
  });
});
