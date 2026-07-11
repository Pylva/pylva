// Tailwind v4 PostCSS config — uses @tailwindcss/postcss exclusively
// (the v4 plugin handles @import, @apply, @theme, dark mode, etc.).
// Autoprefixer is bundled into the v4 plugin; no separate step.

const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};

export default config;
