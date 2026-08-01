'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useId, useState } from 'react';

import { ThemeToggle } from '@/components/ThemeToggle';
import {
  ADMIN_NAV,
  isActive,
  meNav,
  type NavGroup,
  ORG_NAV,
  type Scope,
  scopeOf,
  teamNav,
  teamSlugOf,
} from './nav-model';

export type RailTeam = { githubSlug: string; name: string };

type RailProps = {
  canViewOrg: boolean;
  isAdmin: boolean;
  showGrants: boolean;
  teams: RailTeam[];
  userLabel: string;
};

const SCOPE_LABEL: Record<Scope, string> = {
  admin: 'Admin',
  me: 'Me',
  org: 'Org',
  team: 'Team',
};

function initials(name: string): string {
  const parts = name
    .trim()
    .split(/[\s_-]+/)
    .filter(Boolean);
  const letters =
    parts.length > 1 ? `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}` : name.slice(0, 2);
  return letters.toUpperCase();
}

export function Rail({ canViewOrg, isAdmin, showGrants, teams, userLabel }: RailProps) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const drawerId = useId();

  // A navigation is the end of a drawer's usefulness.
  useEffect(() => setOpen(false), [pathname]);

  const scope = scopeOf(pathname);
  const activeTeam = scope === 'team' ? teamSlugOf(pathname) : (teams[0]?.githubSlug ?? null);

  let groups: NavGroup[] = [];
  if (scope === 'me') {
    groups = meNav(showGrants);
  } else if (scope === 'team' && activeTeam) {
    groups = teamNav(activeTeam);
  } else if (scope === 'org') {
    groups = ORG_NAV;
  } else if (scope === 'admin') {
    groups = ADMIN_NAV;
  }

  const scopes: { href: string; scope: Scope }[] = [
    { href: '/me', scope: 'me' },
    ...(activeTeam ? [{ href: `/team/${activeTeam}`, scope: 'team' as Scope }] : []),
    ...(canViewOrg ? [{ href: '/org/dashboard', scope: 'org' as Scope }] : []),
    ...(isAdmin ? [{ href: '/admin', scope: 'admin' as Scope }] : []),
  ];

  return (
    <>
      {/* Mobile bar — the rail collapses to a single control below `lg`. */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3 lg:hidden">
        <Link href="/me" className="font-display text-sm font-semibold tracking-tight text-text">
          Observability
        </Link>
        <div className="flex items-center gap-4">
          <ThemeToggle />
          <button
            type="button"
            aria-expanded={open}
            aria-controls={drawerId}
            onClick={() => setOpen((v) => !v)}
            className="rounded-md border border-border px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-widest text-text-2 transition-colors hover:text-text"
          >
            {open ? 'Close' : 'Menu'}
          </button>
        </div>
      </div>

      <nav
        id={drawerId}
        aria-label="Primary"
        className={`${
          open ? 'flex' : 'hidden'
        } shrink-0 flex-col gap-6 border-border bg-surface px-3 py-4 max-lg:border-b lg:flex lg:w-56 lg:border-r`}
      >
        <Link
          href="/me"
          className="hidden items-center gap-2 px-2 font-display text-sm font-semibold tracking-tight text-text lg:flex"
        >
          Observability
        </Link>

        {scopes.length > 1 && (
          <div className="flex rounded-lg border border-border bg-surface-2 p-0.5">
            {scopes.map((s) => (
              <Link
                key={s.scope}
                href={s.href}
                aria-current={scope === s.scope ? 'page' : undefined}
                className={`flex-1 rounded-md py-1.5 text-center font-mono text-[10px] uppercase tracking-widest transition-colors ${
                  scope === s.scope ? 'bg-surface text-text' : 'text-text-3 hover:text-text'
                }`}
              >
                {SCOPE_LABEL[s.scope]}
              </Link>
            ))}
          </div>
        )}

        {scope === 'team' && teams.length > 1 && <TeamPicker current={activeTeam} teams={teams} />}

        {groups.map((group) => (
          <div key={group.label} className="flex flex-col gap-0.5">
            <p className="px-2 pb-1.5 font-mono text-[9.5px] uppercase tracking-widest text-text-3">
              {group.label}
            </p>
            {group.items.map((item) => {
              const active = isActive(pathname, item);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={`relative flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors ${
                    active
                      ? 'bg-accent-dim font-medium text-text before:absolute before:top-1.5 before:bottom-1.5 before:-left-3 before:w-0.5 before:rounded-r-sm before:bg-accent'
                      : 'text-text-2 hover:bg-surface-2 hover:text-text'
                  }`}
                >
                  <Icon size={14} className="shrink-0 opacity-80" />
                  {item.label}
                </Link>
              );
            })}
          </div>
        ))}

        <div className="mt-auto hidden items-center gap-2.5 px-2 pt-4 lg:flex">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border bg-surface-2 font-mono text-[9px] text-text-2">
            {initials(userLabel)}
          </span>
          <span className="truncate text-xs text-text-2" title={userLabel}>
            {userLabel}
          </span>
          <ThemeToggle />
        </div>
      </nav>
    </>
  );
}

function TeamPicker({ current, teams }: { current: string | null; teams: RailTeam[] }) {
  return (
    <label className="px-1">
      <span className="sr-only">Team</span>
      <select
        value={current ?? ''}
        onChange={(e) => {
          window.location.href = `/team/${e.target.value}`;
        }}
        className="w-full rounded-md border border-border bg-surface-2 px-2 py-1.5 text-xs text-text focus:ring-1 focus:ring-accent focus:outline-none"
      >
        {teams.map((t) => (
          <option key={t.githubSlug} value={t.githubSlug}>
            {t.name}
          </option>
        ))}
      </select>
    </label>
  );
}
