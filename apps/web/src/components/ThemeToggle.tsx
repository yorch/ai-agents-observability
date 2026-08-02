'use client';

import { useSyncExternalStore } from 'react';

import { MoonIcon, SunIcon } from '@/components/icons';

/**
 * `html.light` is the single source of truth, not per-instance state — the rail
 * mounts a toggle in both the mobile bar and the desktop footer, and isolated
 * `useState` would let them disagree after a viewport change.
 */
function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributeFilter: ['class'], attributes: true });
  return () => observer.disconnect();
}

const isLight = () => document.documentElement.classList.contains('light');

export function ThemeToggle() {
  // The server has no DOM, so the SSR snapshot reports the default theme; the
  // observer corrects it on mount.
  const light = useSyncExternalStore(subscribe, isLight, () => false);

  const toggle = () => {
    const next = !isLight();
    document.documentElement.classList.toggle('light', next);
    localStorage.setItem('theme', next ? 'light' : 'dark');
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="Toggle light/dark mode"
      aria-pressed={light}
      className="text-text-3 transition-colors hover:text-text-2"
      title={light ? 'Switch to dark' : 'Switch to light'}
    >
      {light ? <MoonIcon size={15} /> : <SunIcon size={15} />}
    </button>
  );
}
