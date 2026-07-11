// CSS imports in Next.js are handled by the bundler at build time; TypeScript
// only needs to know they're valid side-effect imports. Without this, tsc
// flags `import './globals.css'` as a missing module.
declare module '*.css';
