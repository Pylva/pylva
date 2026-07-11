import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { CopyButton } from '@/components/ui/CopyButton';

const LABELS = {
  label: 'Copy key',
  copiedLabel: 'Copied',
  errorLabel: 'Copy failed — select the text and copy manually',
};

type ExecCommandCarrier = { execCommand?: (command: string) => boolean };

describe('<CopyButton>', () => {
  beforeEach(() => {
    delete (document as ExecCommandCarrier).execCommand;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (document as ExecCommandCarrier).execCommand;
  });

  it('writes the exact text to the clipboard and flips to the copied label', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const onCopied = vi.fn();

    render(<CopyButton text="pv_live_once_secret" onCopied={onCopied} {...LABELS} />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy key' }));

    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('pv_live_once_secret');
    expect(onCopied).toHaveBeenCalledTimes(1);
  });

  it('falls back to execCommand when navigator.clipboard is unavailable', async () => {
    vi.stubGlobal('navigator', {});
    const execCommand = vi.fn().mockReturnValue(true);
    (document as ExecCommandCarrier).execCommand = execCommand;
    const onCopied = vi.fn();

    render(<CopyButton text="fallback text" onCopied={onCopied} {...LABELS} />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy key' }));

    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(onCopied).toHaveBeenCalledTimes(1);
  });

  it('shows the error label and skips onCopied when no copy path exists', async () => {
    vi.stubGlobal('navigator', {});
    const onCopied = vi.fn();

    render(<CopyButton text="anything" onCopied={onCopied} {...LABELS} />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy key' }));

    expect(
      await screen.findByRole('button', { name: LABELS.errorLabel }),
    ).toBeInTheDocument();
    expect(onCopied).not.toHaveBeenCalled();
  });

  it('shows the error label when the async clipboard write rejects and execCommand is absent', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const onCopied = vi.fn();

    render(<CopyButton text="anything" onCopied={onCopied} {...LABELS} />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy key' }));

    expect(
      await screen.findByRole('button', { name: LABELS.errorLabel }),
    ).toBeInTheDocument();
    expect(onCopied).not.toHaveBeenCalled();
  });
});
