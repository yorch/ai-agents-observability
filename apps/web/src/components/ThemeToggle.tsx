'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';

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
  // The server has no DOM, so the first paint has to assume the default theme;
  // `mounted` withholds the icon until the real value is known rather than
  // rendering a wrong one.
  const light = useSyncExternalStore(subscribe, isLight, () => false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

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
      aria-pressed={mounted ? light : undefined}
      className="text-text-3 transition-colors hover:text-text-2"
      title={light ? 'Switch to dark' : 'Switch to light'}
    >
      {mounted && light ? (
        <svg width="15" height="15" viewBox="0 0 15 15" fill="none" role="img" aria-label="Moon">
          <path
            d="M7.5 1a6.5 6.5 0 1 0 4.975 10.697A5 5 0 0 1 6.197 4.025 6.48 6.48 0 0 0 7.5 1Z"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <svg width="15" height="15" viewBox="0 0 15 15" fill="none" role="img" aria-label="Sun">
          <circle cx="7.5" cy="7.5" r="2.5" stroke="currentColor" strokeWidth="1.2" />
          <path
            d="M7.5 1v1M7.5 13v1M1 7.5h1M13 7.5h1M3.05 3.05l.707.707M11.243 11.243l.707.707M11.243 3.757l-.707.707M3.757 11.243l-.707.707"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
        </svg>
      )}
    </button>
  );
}
