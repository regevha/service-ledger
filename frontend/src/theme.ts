import { useSyncExternalStore } from 'react';

/**
 * Light or dark, chosen by the person. With nothing chosen the app follows the device; after the
 * first press the choice stays, kept in this browser only (there are no accounts to keep it in).
 */
export type Theme = 'light' | 'dark';

const KEY = 'sl.theme';
const listeners = new Set<() => void>();

function stored(): Theme | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null; // private window or blocked storage: follow the device
  }
}

function device(): Theme {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** The theme in force right now. */
export function currentTheme(): Theme {
  return stored() ?? device();
}

/** Puts the saved choice on <html data-theme>. Called once before the first render. */
export function applyStoredTheme(): void {
  const t = stored();
  if (t) document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}

export function setTheme(t: Theme): void {
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* not remembered after a reload; this page still changes */
  }
  document.documentElement.dataset.theme = t;
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
  mq?.addEventListener('change', cb);
  return () => {
    listeners.delete(cb);
    mq?.removeEventListener('change', cb);
  };
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const theme = useSyncExternalStore(subscribe, currentTheme, () => 'light' as Theme);
  return [theme, setTheme];
}
