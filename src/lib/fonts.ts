// Brand fonts — loaded ONCE here and applied on <html> by the root layout so
// the CSS variables exist on every surface (marketing, dashboard, login,
// portal). Self-hosted via next/font, latin subset, swap.
// Moved out of (marketing)/layout.tsx in the one-brand re-skin (2026-06-11);
// login previously referenced these variables with nothing loading them.

import { Inter, Inter_Tight, JetBrains_Mono } from 'next/font/google';

export const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

export const interTight = Inter_Tight({
  subsets: ['latin'],
  variable: '--font-inter-tight',
  display: 'swap',
});

export const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains-mono',
  display: 'swap',
});

/** Class string applying all three font variables; used on <html>. */
export const fontVariables = `${inter.variable} ${interTight.variable} ${jetbrainsMono.variable}`;
