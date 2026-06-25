'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, useTransition } from 'react';

type Props = {
  displayName: string;
};

export function UserMenu({ displayName }: Props) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function handleEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', handleOutside);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('mousedown', handleOutside);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [open]);

  const signOut = () => {
    setOpen(false);
    startTransition(async () => {
      await fetch('/api/auth/logout', { method: 'POST' });
      window.location.href = '/login';
    });
  };

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-sm text-text-2 hover:text-text transition-colors"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-accent/15 text-accent text-xs font-semibold select-none">
          {displayName[0]?.toUpperCase() ?? '?'}
        </span>
        <span>{displayName}</span>
        <svg
          className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`}
          viewBox="0 0 16 16"
          fill="currentColor"
          aria-hidden
        >
          <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-2 w-44 rounded-lg border border-border bg-surface shadow-lg py-1 z-50"
        >
          <Link
            href="/me"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2.5 px-3 py-2 text-sm text-text-2 hover:text-text hover:bg-surface-2 transition-colors"
          >
            <span aria-hidden>⚡</span> My Agents
          </Link>
          <Link
            href="/me/profile"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2.5 px-3 py-2 text-sm text-text-2 hover:text-text hover:bg-surface-2 transition-colors"
          >
            <span aria-hidden>👤</span> Profile
          </Link>
          <Link
            href="/me/privacy"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2.5 px-3 py-2 text-sm text-text-2 hover:text-text hover:bg-surface-2 transition-colors"
          >
            <span aria-hidden>🔒</span> Privacy
          </Link>
          <Link
            href="/install"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2.5 px-3 py-2 text-sm text-text-2 hover:text-text hover:bg-surface-2 transition-colors"
          >
            <span aria-hidden>📦</span> Install hook
          </Link>
          <div className="my-1 border-t border-border" />
          <button
            type="button"
            role="menuitem"
            onClick={signOut}
            disabled={pending}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-text-2 hover:text-text hover:bg-surface-2 transition-colors disabled:opacity-40"
          >
            <span aria-hidden>→</span> {pending ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      )}
    </div>
  );
}
