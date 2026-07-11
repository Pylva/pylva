// Modal dialog primitive, source-committed alongside button.tsx (D17 policy:
// shadcn-style primitives live in src/components/ui/*, no runtime dep).
//
// Rendered through a portal with a fixed backdrop; the panel is labelled via
// aria-labelledby/aria-describedby, traps Tab focus, locks body scroll, and
// restores focus to the previously focused element on close.
//
// Escape always calls onClose — pressing it is a deliberate act. Backdrop
// clicks are gated by `closeOnBackdrop` (default true): dialogs showing a
// shown-once secret pass false so a stray click can't destroy the content.

'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  /** id of the heading element inside `children` */
  labelledBy: string;
  /** id of the descriptive element inside `children` */
  describedBy?: string;
  closeOnBackdrop?: boolean;
  className?: string;
  children: React.ReactNode;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Dialog({
  open,
  onClose,
  labelledBy,
  describedBy,
  closeOnBackdrop = true,
  className,
  children,
}: DialogProps) {
  const panelRef = React.useRef<HTMLDivElement>(null);
  const restoreFocusRef = React.useRef<HTMLElement | null>(null);
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => setMounted(true), []);

  // Focus management: remember the opener, move focus into the panel, restore
  // on close. Depends on `mounted` because the portal (and thus panelRef)
  // only exists after the first client render.
  React.useEffect(() => {
    if (!open || !mounted) return;
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const initial =
      panel?.querySelector<HTMLElement>('[data-autofocus]') ??
      panel?.querySelector<HTMLElement>(FOCUSABLE);
    initial?.focus();
    return () => {
      restoreFocusRef.current?.focus?.();
    };
  }, [open, mounted]);

  // Body scroll lock while open.
  React.useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    // Minimal focus trap: cycle Tab within the panel.
    const panel = panelRef.current;
    if (!panel) return;
    const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  if (!mounted || !open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(e) => {
        if (closeOnBackdrop && e.target === e.currentTarget) onClose();
      }}
      data-testid="dialog-backdrop"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        onKeyDown={handleKeyDown}
        className={cn(
          'w-full max-w-lg rounded-[var(--radius)] border border-[color:var(--border)] bg-[color:var(--popover)] p-6 text-[color:var(--popover-foreground)] shadow-lg',
          className,
        )}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
