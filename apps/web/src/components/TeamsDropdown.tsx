'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

type TeamEntry = { githubSlug: string; name: string };

function IconChevron({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden={true}
      className={`transition-transform ${open ? 'rotate-180' : ''}`}
    >
      <path
        d="M2.5 4.5L6 8l3.5-3.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function TeamsDropdown({ teams }: { teams: TeamEntry[] }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    function handleOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function handleEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleOutside);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('mousedown', handleOutside);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [open]);

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-sm text-text-2 hover:text-text transition-colors"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        Teams
        <IconChevron open={open} />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-2 w-48 rounded-lg border border-border bg-surface shadow-lg py-1 z-50"
        >
          {teams.map((t) => (
            <Link
              key={t.githubSlug}
              href={`/team/${t.githubSlug}`}
              role="menuitem"
              onClick={() => setOpen(false)}
              className="block px-3 py-2 text-sm text-text-2 hover:text-text hover:bg-surface-2 transition-colors"
            >
              {t.name}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
