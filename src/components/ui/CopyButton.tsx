'use client';

import { useEffect, useRef, useState } from 'react';

// Clipboard affordance for one-time secrets and generated snippets.
//
// This component never imports analytics: call sites pass a metadata-only
// onCopied callback, so the copied text cannot reach tracking through this
// component by construction.
//
// Deliberately a plain token-styled button (no ui/button import): it renders
// inside the dashboard page's onboarding surface, which has a strict
// chunk-count performance budget.

const COPIED_RESET_MS = 2000;

async function writeClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the legacy path (denied permission, insecure context).
    }
  }
  // Self-hosted deployments served over plain http have no navigator.clipboard.
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') {
    return false;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}

interface CopyButtonProps {
  text: string;
  label: string;
  copiedLabel: string;
  errorLabel: string;
  onCopied?: () => void;
  className?: string;
}

export function CopyButton({
  text,
  label,
  copiedLabel,
  errorLabel,
  onCopied,
  className,
}: CopyButtonProps) {
  const [state, setState] = useState<'idle' | 'copied' | 'error'>('idle');
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );

  async function copy() {
    const ok = await writeClipboard(text);
    setState(ok ? 'copied' : 'error');
    if (ok) onCopied?.();
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setState('idle'), COPIED_RESET_MS);
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-live="polite"
      className={`rounded-md border px-3 py-1 text-xs font-medium ${className ?? ''}`}
      style={{
        borderColor: 'var(--border)',
        background: 'var(--background)',
        color: 'var(--foreground)',
      }}
    >
      {state === 'copied' ? copiedLabel : state === 'error' ? errorLabel : label}
    </button>
  );
}
