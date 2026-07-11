import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { COPY } from '@/lib/copy';
import { ApiKeyCreatedDialog } from '@/components/settings/ApiKeyCreatedDialog';
import { Dialog } from '@/components/ui/dialog';

const PLAINTEXT = `pv_live_deadbeef_${'c'.repeat(32)}`;

function defineClipboard(writeText: (value: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
}

function removeClipboard() {
  // jsdom has no navigator.clipboard by default; delete restores that state.
  delete (navigator as unknown as Record<string, unknown>)['clipboard'];
}

describe('<ApiKeyCreatedDialog>', () => {
  afterEach(() => {
    removeClipboard();
  });

  it('renders the title, key, capability statement, and shown-once warning', async () => {
    render(<ApiKeyCreatedDialog plaintext={PLAINTEXT} onDone={vi.fn()} />);

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(COPY.api_key_created_title);
    expect(dialog).toHaveTextContent(PLAINTEXT);
    expect(dialog).toHaveTextContent(COPY.api_key_capability);
    expect(dialog).toHaveTextContent(COPY.api_key_shown_once);
    expect(screen.getByRole('button', { name: COPY.api_key_done })).toBeInTheDocument();
  });

  it('renders nothing when plaintext is null', () => {
    render(<ApiKeyCreatedDialog plaintext={null} onDone={vi.fn()} />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('focuses the copy button on open', async () => {
    render(<ApiKeyCreatedDialog plaintext={PLAINTEXT} onDone={vi.fn()} />);

    await screen.findByRole('dialog');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: COPY.api_key_copy })).toHaveFocus(),
    );
  });

  it('copies via navigator.clipboard and shows transient Copied feedback', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    defineClipboard(writeText);

    render(<ApiKeyCreatedDialog plaintext={PLAINTEXT} onDone={vi.fn()} />);
    await screen.findByRole('dialog');

    fireEvent.click(screen.getByRole('button', { name: COPY.api_key_copy }));

    expect(await screen.findByText(COPY.api_key_copied)).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith(PLAINTEXT);
  });

  it('falls back to execCommand when the clipboard API is unavailable', async () => {
    removeClipboard();
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true });

    render(<ApiKeyCreatedDialog plaintext={PLAINTEXT} onDone={vi.fn()} />);
    await screen.findByRole('dialog');

    fireEvent.click(screen.getByRole('button', { name: COPY.api_key_copy }));

    expect(await screen.findByText(COPY.api_key_copied)).toBeInTheDocument();
    expect(execCommand).toHaveBeenCalledWith('copy');

    delete (document as unknown as Record<string, unknown>)['execCommand'];
  });

  it('shows the manual-copy hint when both copy strategies fail — never a dead button', async () => {
    removeClipboard();
    // jsdom has no document.execCommand, so the fallback fails too.

    render(<ApiKeyCreatedDialog plaintext={PLAINTEXT} onDone={vi.fn()} />);
    await screen.findByRole('dialog');

    fireEvent.click(screen.getByRole('button', { name: COPY.api_key_copy }));

    expect(await screen.findByRole('alert')).toHaveTextContent(COPY.api_key_copy_manual);
  });

  it('treats Escape as Done but ignores backdrop clicks', async () => {
    const onDone = vi.fn();
    render(<ApiKeyCreatedDialog plaintext={PLAINTEXT} onDone={onDone} />);

    const dialog = await screen.findByRole('dialog');

    fireEvent.mouseDown(screen.getByTestId('dialog-backdrop'));
    expect(onDone).not.toHaveBeenCalled();

    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('locks body scroll while open and unlocks on close', async () => {
    const { rerender } = render(<ApiKeyCreatedDialog plaintext={PLAINTEXT} onDone={vi.fn()} />);

    await screen.findByRole('dialog');
    expect(document.body.style.overflow).toBe('hidden');

    rerender(<ApiKeyCreatedDialog plaintext={null} onDone={vi.fn()} />);
    await waitFor(() => expect(document.body.style.overflow).toBe(''));
  });
});

describe('<Dialog> primitive', () => {
  beforeEach(() => {
    document.body.style.overflow = '';
  });

  it('closes on Escape and backdrop click when closeOnBackdrop is enabled', async () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} labelledBy="t">
        <h2 id="t">Generic</h2>
        <button type="button">ok</button>
      </Dialog>,
    );

    const dialog = await screen.findByRole('dialog');
    fireEvent.mouseDown(screen.getByTestId('dialog-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('moves focus into the panel on open and restores it on close', async () => {
    const outside = document.createElement('button');
    outside.textContent = 'opener';
    document.body.appendChild(outside);
    outside.focus();

    const { rerender } = render(
      <Dialog open onClose={vi.fn()} labelledBy="t2">
        <h2 id="t2">Generic</h2>
        <button type="button">inside</button>
      </Dialog>,
    );

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'inside' })).toHaveFocus(),
    );

    rerender(
      <Dialog open={false} onClose={vi.fn()} labelledBy="t2">
        <h2 id="t2">Generic</h2>
        <button type="button">inside</button>
      </Dialog>,
    );
    await waitFor(() => expect(outside).toHaveFocus());

    document.body.removeChild(outside);
  });

  it('traps Tab focus within the panel', async () => {
    render(
      <Dialog open onClose={vi.fn()} labelledBy="t3">
        <h2 id="t3">Generic</h2>
        <button type="button">first</button>
        <button type="button">last</button>
      </Dialog>,
    );

    const dialog = await screen.findByRole('dialog');
    const last = screen.getByRole('button', { name: 'last' });
    last.focus();

    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(screen.getByRole('button', { name: 'first' })).toHaveFocus();

    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
  });
});
