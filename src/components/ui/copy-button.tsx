// Copy-to-clipboard button (ui primitive, D17 policy).
//
// Fallback chain — the button must never be dead:
//   1. navigator.clipboard.writeText (secure contexts)
//   2. hidden-textarea + document.execCommand('copy') (older/insecure contexts)
//   3. onFallback() so the caller can show a manual-copy hint
// The "Copied" state reverts after ~2s and is announced via aria-live.

'use client';

import * as React from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { COPY } from '@/lib/copy';

export interface CopyButtonProps {
  value: string;
  label?: string;
  copiedLabel?: string;
  /** Called only after a successful copy; never receives the copied value. */
  onCopied?: () => void;
  /** Called when both copy strategies fail (caller shows a manual hint). */
  onFallback?: () => void;
  className?: string;
  'data-autofocus'?: boolean;
}

function execCommandCopy(value: string): boolean {
  try {
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

export function CopyButton({
  value,
  label = COPY.api_key_copy,
  copiedLabel = COPY.api_key_copied,
  onCopied,
  onFallback,
  className,
  ...rest
}: CopyButtonProps) {
  const [copied, setCopied] = React.useState(false);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const markCopied = () => {
    setCopied(true);
    onCopied?.();
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 2000);
  };

  const copy = async () => {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(value);
        markCopied();
        return;
      } catch {
        // fall through to execCommand
      }
    }
    if (execCommandCopy(value)) {
      markCopied();
      return;
    }
    onFallback?.();
  };

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => void copy()}
      className={className}
      {...rest}
    >
      {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      <span aria-live="polite">{copied ? copiedLabel : label}</span>
    </Button>
  );
}
