import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

const { refreshMock } = vi.hoisted(() => ({
  refreshMock: vi.fn(),
}));

vi.mock('next/navigation.js', () => ({
  useRouter: () => ({ refresh: refreshMock }),
  usePathname: () => '/o/acme/dashboard',
}));

import { UsageDataUnavailable } from '@/components/dashboard/UsageDataUnavailable';

const STORAGE_KEY = 'pylva.usage-retry./o/acme/dashboard';

describe('<UsageDataUnavailable>', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    refreshMock.mockReset();
    window.sessionStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the page header, status card, and retry button', () => {
    render(<UsageDataUnavailable title="Overview" />);

    expect(screen.getByRole('heading', { name: 'Overview' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Usage data unavailable');
    expect(screen.getByRole('status')).toHaveTextContent(
      'Recent cost data could not be loaded. The rest of the dashboard is still available.',
    );
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
  });

  it('manual retry triggers a router refresh', () => {
    render(<UsageDataUnavailable title="Overview" />);

    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));

    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it('auto-retries exactly once after the delay and stamps the suppression key', () => {
    render(<UsageDataUnavailable title="Overview" />);

    act(() => {
      vi.advanceTimersByTime(9_999);
    });
    expect(refreshMock).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(Number(window.sessionStorage.getItem(STORAGE_KEY))).toBeGreaterThan(0);

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it('suppresses the auto-retry after a recent one, while manual retry still works', () => {
    window.sessionStorage.setItem(STORAGE_KEY, String(Date.now()));

    render(<UsageDataUnavailable title="Overview" />);

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(refreshMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it('auto-retries again once the suppression window has passed', () => {
    window.sessionStorage.setItem(STORAGE_KEY, String(Date.now() - 6 * 60_000));

    render(<UsageDataUnavailable title="Overview" />);

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it('clears the pending auto-retry on unmount', () => {
    const { unmount } = render(<UsageDataUnavailable title="Overview" />);

    unmount();
    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(refreshMock).not.toHaveBeenCalled();
  });
});
