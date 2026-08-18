'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { SearchIcon } from '@/components/icons';
import { useFocusTrap } from '@/lib/use-focus-trap';
import { ADMIN_NAV, meNav, type NavGroup, ORG_NAV, teamNav } from './nav-model';

type Command = { group: string; href: string; label: string };

function flatten(groups: NavGroup[], scope: string): Command[] {
  return groups.flatMap((g) =>
    g.items.map((i) => ({ group: `${scope} · ${g.label}`, href: i.href, label: i.label })),
  );
}

/**
 * Cmd/Ctrl+K navigation over the same `nav-model` data the rail renders — an
 * accelerator on top of the rail, not a second nav surface. With sixteen org
 * sections and ten admin pages, power users get any page in three keystrokes.
 */
export function CommandPalette({
  canViewOrg,
  isAdmin,
  showGrants,
  teamSlug,
}: {
  canViewOrg: boolean;
  isAdmin: boolean;
  showGrants: boolean;
  teamSlug: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const [isMac, setIsMac] = useState(false);
  const router = useRouter();
  const dialogRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // The trap owns Escape-to-close so stacked layers (palette over drawer)
  // close one at a time.
  useFocusTrap(dialogRef, open, () => setOpen(false));

  useEffect(() => {
    setIsMac(/mac/i.test(navigator.platform));
  }, []);

  const commands = useMemo(() => {
    const all = flatten(meNav(showGrants), 'Me');
    if (teamSlug) {
      all.push(...flatten(teamNav(teamSlug), 'Team'));
    }
    if (canViewOrg) {
      all.push(...flatten(ORG_NAV, 'Org'));
    }
    if (isAdmin) {
      all.push(...flatten(ADMIN_NAV, 'Admin'));
    }
    return all;
  }, [canViewOrg, isAdmin, showGrants, teamSlug]);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return commands;
    }
    return commands.filter((c) => `${c.group} ${c.label}`.toLowerCase().includes(needle));
  }, [commands, query]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setIndex(0);
    }
  }, [open]);

  // Keep the selection valid and visible as the result set narrows.
  const clamped = Math.min(index, Math.max(0, results.length - 1));
  useEffect(() => {
    listRef.current
      ?.querySelector(`#palette-option-${clamped}`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [clamped]);

  function go(href: string) {
    setOpen(false);
    router.push(href);
  }

  function onInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      // Empty result list: clamped is -1 and Math.min would lock the index at
      // -1, leaving Enter dead even after results return.
      setIndex(Math.max(0, Math.min(clamped + 1, results.length - 1)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex(Math.max(clamped - 1, 0));
    } else if (e.key === 'Enter') {
      const target = results[clamped];
      if (target) {
        e.preventDefault();
        go(target.href);
      }
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-xs text-text-3 transition-colors hover:border-border-strong hover:text-text-2"
      >
        <SearchIcon size={12} />
        <span>Go to…</span>
        <kbd className="ml-auto rounded border border-border-subtle bg-surface-2 px-1.5 py-0.5 font-mono text-[10px]">
          {isMac ? '⌘' : 'Ctrl'} K
        </kbd>
      </button>

      {/* Portaled to <body>: the trigger lives inside the rail nav, which is
          display:none below lg while the drawer is closed — an overlay
          rendered in place would open invisibly on those viewports. */}
      {open &&
        createPortal(
          // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-close duplicates the Escape affordance; the dialog itself is keyboard-complete
          <div
            className="fixed inset-0 z-50 flex items-start justify-center bg-bg/60 pt-[15vh]"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) {
                setOpen(false);
              }
            }}
          >
            <div
              ref={dialogRef}
              role="dialog"
              aria-modal="true"
              aria-label="Go to page"
              className="w-full max-w-md rounded-lg border border-border bg-surface shadow-xl"
            >
              <div className="flex items-center gap-2 border-b border-border px-3">
                <SearchIcon size={14} className="shrink-0 text-text-3" />
                <input
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setIndex(0);
                  }}
                  onKeyDown={onInputKeyDown}
                  placeholder="Go to page…"
                  role="combobox"
                  aria-expanded="true"
                  aria-controls="palette-listbox"
                  aria-activedescendant={
                    results.length > 0 ? `palette-option-${clamped}` : undefined
                  }
                  aria-autocomplete="list"
                  className="w-full bg-transparent py-3 text-sm text-text outline-none placeholder:text-text-3"
                />
              </div>
              {/* The ARIA APG combobox pattern: the roles carry the semantics
                (divs, so no native semantics conflict), focus stays on the
                input, and options are reached via aria-activedescendant —
                deliberately not tab stops. */}
              <div
                ref={listRef}
                id="palette-listbox"
                role="listbox"
                aria-label="Pages"
                className="max-h-72 overflow-y-auto p-1.5"
              >
                {results.length === 0 && (
                  <p className="px-2.5 py-6 text-center text-sm text-text-3">No matching pages.</p>
                )}
                {results.map((c, i) => (
                  // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard selection happens in the combobox input (ArrowUp/Down + Enter), per the ARIA combobox pattern
                  // biome-ignore lint/a11y/useFocusableInteractive: options are reached via aria-activedescendant, not Tab — focus stays on the combobox input
                  <div
                    key={c.href}
                    id={`palette-option-${i}`}
                    role="option"
                    aria-selected={i === clamped}
                    onMouseEnter={() => setIndex(i)}
                    onClick={() => go(c.href)}
                    className={`flex cursor-pointer items-baseline justify-between gap-3 rounded-md px-2.5 py-2 text-sm ${
                      i === clamped ? 'bg-accent-dim text-text' : 'text-text-2'
                    }`}
                  >
                    <span>{c.label}</span>
                    <span className="shrink-0 font-mono text-[10px] uppercase tracking-widest text-text-3">
                      {c.group}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
