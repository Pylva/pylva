// Dashboard table primitives, source-committed per D17 policy (shadcn-style
// components live in src/components/ui/*; hand-synced, no CLI dep). Server-safe:
// no hooks and no 'use client', so RSC pages and client components can both
// render them.
//
// All dashboard data tables MUST be composed from these primitives — do not
// hand-roll <table> markup in pages (enforced by no-restricted-syntax in
// eslint.config.js). Conventions: numeric columns add `text-end tabular-nums`
// at the call site; empty values render an em dash (—); wrap page-level tables
// in <TableContainer> for the app-card frame + horizontal overflow scrolling.
//
// Cells bake in horizontal padding (px-4) so content never sits flush against
// the card border; overrides merge safely via cn() (e.g. `py-1` for compact
// rows replaces the default `py-3` without dropping `px-4`).

import * as React from 'react';

import { cn } from '@/lib/utils';

export function TableContainer({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  // [contain:layout] stops iOS WebKit from propagating the scrollable
  // overflow of a wide table to the viewport — without it the whole page
  // pans sideways on iPhone even though this card scrolls internally.
  return <div className={cn('app-card overflow-x-auto [contain:layout]', className)} {...props} />;
}

export function Table({
  className,
  ...props
}: React.TableHTMLAttributes<HTMLTableElement>): React.ReactElement {
  // eslint-disable-next-line no-restricted-syntax -- the one blessed raw <table>
  return <table className={cn('w-full text-sm', className)} {...props} />;
}

export function TableHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLTableSectionElement>): React.ReactElement {
  return (
    <thead
      className={cn(
        'text-xs uppercase tracking-wider text-[color:var(--muted-foreground)]',
        className,
      )}
      {...props}
    />
  );
}

export function TableBody({
  className,
  ...props
}: React.HTMLAttributes<HTMLTableSectionElement>): React.ReactElement {
  return (
    <tbody
      className={cn(
        '[&_tr:last-child]:border-0 [&_tr:hover]:bg-[color-mix(in_oklab,var(--foreground)_5%,transparent)]',
        className,
      )}
      {...props}
    />
  );
}

export function TableRow({
  className,
  ...props
}: React.HTMLAttributes<HTMLTableRowElement>): React.ReactElement {
  return (
    <tr
      className={cn('border-b border-[color:var(--border)] transition-colors', className)}
      {...props}
    />
  );
}

export function TableHead({
  className,
  ...props
}: React.ThHTMLAttributes<HTMLTableCellElement>): React.ReactElement {
  return <th className={cn('px-4 py-2 text-start font-medium', className)} {...props} />;
}

export function TableCell({
  className,
  ...props
}: React.TdHTMLAttributes<HTMLTableCellElement>): React.ReactElement {
  return <td className={cn('px-4 py-3 align-middle', className)} {...props} />;
}
