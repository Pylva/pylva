// Tailwind v4 config. v4 loads theme tokens from CSS (`@theme` in
// src/app/globals.css), so this file is mostly for editor tooling
// (IntelliSense) + the `content` glob + the `darkMode` switch.
// Design decisions (§4.3 + D18/D19):
//   - Stripe-inspired: warm indigo primary, warm gray surfaces
//   - Dark mode: class-based toggle + system default (via ThemeProvider)
//   - Theme tokens for shadcn components live in globals.css

import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/app/**/*.{ts,tsx}', './src/components/**/*.{ts,tsx}', './src/lib/**/*.{ts,tsx}'],
  darkMode: 'class',
};

export default config;
