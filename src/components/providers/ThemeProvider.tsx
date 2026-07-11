// B2a Phase 0a — minimal ThemeProvider (D19).
// System-follow by default; toggle via <ThemeToggle /> (introduced in T1).
// Respects prefers-color-scheme + reads/writes localStorage('pylva:theme').
//
// Why not `next-themes`? We already have one theme dep (Tailwind v4 + shadcn
// tokens in globals.css). `next-themes` adds 3KB gzipped for a flip-class
// contract we can write in ~30 lines. Add it later if the toggle UX grows.

'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';

type Theme = 'light' | 'dark' | 'system';

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  resolvedTheme: 'light' | 'dark';
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const STORAGE_KEY = 'pylva:theme';

function readStoredTheme(): Theme {
  if (typeof window === 'undefined') return 'system';
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  return 'system';
}

function systemPrefersDark(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function applyThemeClass(resolved: 'light' | 'dark') {
  const root = document.documentElement;
  root.classList.toggle('dark', resolved === 'dark');
}

export function ThemeProvider({
  children,
  defaultTheme = 'system',
}: {
  children: React.ReactNode;
  defaultTheme?: Theme;
}) {
  const [theme, setThemeState] = useState<Theme>(defaultTheme);
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>('light');

  // Rehydrate from storage on mount.
  useEffect(() => {
    setThemeState(readStoredTheme());
  }, []);

  // Resolve the applied theme and keep in sync with system changes when in 'system' mode.
  useEffect(() => {
    const resolve = () => {
      const r = theme === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : theme;
      setResolvedTheme(r);
      applyThemeClass(r);
    };
    resolve();

    if (theme !== 'system') return;
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => resolve();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    window.localStorage.setItem(STORAGE_KEY, next);
    setThemeState(next);
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, resolvedTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>');
  return ctx;
}
