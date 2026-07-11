// B2a Phase 0a — shared frontend utilities.
// `cn` is the shadcn-canonical class-name merger: clsx + tailwind-merge.
// Use it in every component that composes conditional Tailwind classes
// to avoid duplicate-modifier hazards (e.g., "p-2 p-4" -> "p-4").

import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
