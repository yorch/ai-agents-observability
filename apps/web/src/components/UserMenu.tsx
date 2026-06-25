'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, useTransition } from 'react';

type Props = {
  displayName: string;
};

function IconAgents() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden>
      <path d="M7.5 1L9.5 5.5H14L10.5 8.5L11.5 13L7.5 10.5L3.5 13L4.5 8.5L1 5.5H5.5L7.5 1Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

function IconProfile() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden>
      <circle cx="7.5" cy="5" r="2.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M2 13c0-3 2.5-5 5.5-5s5.5 2 5.5 5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function IconPrivacy() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden>
      <rect x="3" y="6.5" width="9" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M5 6.5V4.5a2.5 2.5 0 0 1 5 0v2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <circle cx="7.5" cy="10" r="1" fill="currentColor" />
    </svg>
  );
}

function IconInstall() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden>
      <path d="M7.5 1v8M4.5 6.5l3 3 3-3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2 11v1.5A1.5 1.5 0 0 0 3.5 14h8a1.5 1.5 0 0 0 1.5-1.5V11" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function IconSignOut() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden>
      <path d="M6 2H3a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <path d="M10 10l3-2.5L10 5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M13 7.5H6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function IconChevron({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden
      className={`transition-transform ${open ? 'rotate-180' : ''}`}
    >
      <path d="M2.5 4.5L6 8l3.5-3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

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
        <IconChevron open={open} />
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
            <IconAgents /> My Agents
          </Link>
          <Link
            href="/me/profile"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2.5 px-3 py-2 text-sm text-text-2 hover:text-text hover:bg-surface-2 transition-colors"
          >
            <IconProfile /> Profile
          </Link>
          <Link
            href="/me/privacy"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2.5 px-3 py-2 text-sm text-text-2 hover:text-text hover:bg-surface-2 transition-colors"
          >
            <IconPrivacy /> Privacy
          </Link>
          <Link
            href="/install"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2.5 px-3 py-2 text-sm text-text-2 hover:text-text hover:bg-surface-2 transition-colors"
          >
            <IconInstall /> Install hook
          </Link>
          <div className="my-1 border-t border-border" />
          <button
            type="button"
            role="menuitem"
            onClick={signOut}
            disabled={pending}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-text-2 hover:text-text hover:bg-surface-2 transition-colors disabled:opacity-40"
          >
            <IconSignOut /> {pending ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      )}
    </div>
  );
}
