'use client';

import { useEffect, useState } from 'react';

export function ThemeToggle() {
  const [light, setLight] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem('theme');
    const isLight = saved === 'light';
    setLight(isLight);
    document.documentElement.classList.toggle('light', isLight);
  }, []);

  const toggle = () => {
    const next = !light;
    setLight(next);
    document.documentElement.classList.toggle('light', next);
    localStorage.setItem('theme', next ? 'light' : 'dark');
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="Toggle light/dark mode"
      className="text-text-3 hover:text-text-2 transition-colors"
      title={light ? 'Switch to dark' : 'Switch to light'}
    >
      {light ? (
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
