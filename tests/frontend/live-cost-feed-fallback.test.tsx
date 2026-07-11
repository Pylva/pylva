// A CLOSED EventSource never retries and fires no further error events, so
// an error event observed while readyState === CLOSED must drop the badge
// straight to 'Polling' (fallback) — waiting for more strikes would leave it
// stuck on 'Reconnecting…' forever.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';

import { LiveCostFeed } from '@/components/dashboard/LiveCostFeed';

type Listener = (event: Event) => void;

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];

  readyState: number = FakeEventSource.CONNECTING;
  url: string;
  private listeners = new Map<string, Set<Listener>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    this.readyState = FakeEventSource.CLOSED;
  }

  emit(type: string, event: Event = new Event(type)): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

const fetchMock = vi.fn();

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const PROPS = {
  initialTotalUsd: 12.5,
  initialEventCount: 4,
  initialCustomerCount: 2,
  endUserLabel: 'customer',
  customerLabelPlural: 'Customers',
};

describe('<LiveCostFeed> SSE status fallback', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        overview: { total_spend_usd: 20, event_count: 9, customer_count: 3 },
      }),
    );
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal('fetch', fetchMock);
    window.history.pushState({}, '', '/o/org-a/dashboard');
    const meta = document.createElement('meta');
    meta.name = 'pylva-page-session';
    meta.content = '0123456789abcdef';
    document.head.append(meta);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.querySelector('meta[name="pylva-page-session"]')?.remove();
  });

  it('drops straight to the Polling badge on an error with a CLOSED source', async () => {
    render(<LiveCostFeed {...PROPS} />);
    expect(screen.getByText('Connecting…')).toBeInTheDocument();

    const source = FakeEventSource.instances[0]!;
    act(() => {
      source.readyState = FakeEventSource.CLOSED;
      source.emit('error');
    });

    expect(screen.getByText('Polling')).toBeInTheDocument();
    expect(screen.queryByText('Reconnecting…')).not.toBeInTheDocument();

    // Fallback polling starts immediately.
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/v1/costs',
        expect.objectContaining({ credentials: 'include' }),
      );
    });
  });

  it('shows Reconnecting… while the browser is still retrying (not CLOSED)', () => {
    render(<LiveCostFeed {...PROPS} />);

    const source = FakeEventSource.instances[0]!;
    act(() => {
      source.readyState = FakeEventSource.CONNECTING;
      source.emit('error');
    });

    expect(screen.getByText('Reconnecting…')).toBeInTheDocument();
    expect(screen.queryByText('Polling')).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('composes CLOSED SSE fallback through polling into an authoritative mismatch event', async () => {
    fetchMock.mockResolvedValue(jsonResponse(403, { error: { code: 'ORG_MISMATCH' } }));
    const listener = vi.fn();
    window.addEventListener('pylva:session-changed', listener);
    render(<LiveCostFeed {...PROPS} />);

    const source = FakeEventSource.instances[0]!;
    act(() => {
      source.readyState = FakeEventSource.CLOSED;
      source.emit('error');
    });

    await waitFor(() => {
      expect(listener).toHaveBeenCalledTimes(1);
    });
    expect((listener.mock.calls[0]![0] as CustomEvent).detail).toEqual({ code: 'ORG_MISMATCH' });
    window.removeEventListener('pylva:session-changed', listener);
  });
});
