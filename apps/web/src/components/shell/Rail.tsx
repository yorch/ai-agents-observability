'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';

import { ThemeToggle } from '@/components/ThemeToggle';
import { Select } from '@/components/ui/Field';
import { useDict } from '@/i18n/provider';
import { useFocusTrap } from '@/lib/use-focus-trap';
import { CommandPalette } from './CommandPalette';
import { LocaleSwitcher } from './LocaleSwitcher';
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
import { SignOutButton } from './SignOutButton';

export type RailTeam = { githubSlug: string; name: string };

type RailProps = {
  canViewOrg: boolean;
  isAdmin: boolean;
  showGrants: boolean;
  teams: RailTeam[];
  userLabel: string;
};

const SCOPE_LABEL_KEY: Record<Scope, keyof ReturnType<typeof useDict>['rail']> = {
  admin: 'scopeAdmin',
  me: 'scopeMe',
  org: 'scopeOrg',
  team: 'scopeTeam',
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
  const dict = useDict();
  const [open, setOpen] = useState(false);
  const drawerId = useId();
  const drawerRef = useRef<HTMLElement>(null);

  // A navigation is the end of a drawer's usefulness.
  useEffect(() => setOpen(false), [pathname]);

  // While the mobile drawer is open, keep keyboard focus inside it; the trap
  // also owns Escape-to-close (focus returns to the Menu button on teardown).
  // Crossing up to the desktop breakpoint drops the drawer state so the trap
  // cannot linger on the always-visible rail.
  useFocusTrap(drawerRef, open, () => setOpen(false));
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const onChange = () => {
      if (mq.matches) {
        setOpen(false);
      }
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

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
          {dict.rail.productName}
        </Link>
        <div className="flex items-center gap-4">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={drawerId}
            onClick={() => setOpen((v) => !v)}
            className="min-h-11 rounded-md border border-border px-3 py-2.5 font-mono text-[10px] uppercase tracking-widest text-text-2 transition-colors hover:text-text"
          >
            {open ? dict.common.close : dict.common.menu}
          </button>
        </div>
      </div>

      <nav
        id={drawerId}
        ref={drawerRef}
        aria-label={dict.common.primaryNav}
        className={`${
          open ? 'flex' : 'hidden'
        } shrink-0 flex-col gap-6 border-border bg-surface px-3 py-4 max-lg:border-b lg:flex lg:w-56 lg:border-r`}
      >
        <Link
          href="/me"
          className="hidden items-center gap-2 px-2 font-display text-sm font-semibold tracking-tight text-text lg:flex"
        >
          {dict.rail.productName}
        </Link>

        <CommandPalette
          canViewOrg={canViewOrg}
          isAdmin={isAdmin}
          showGrants={showGrants}
          teamSlug={activeTeam}
        />

        {scopes.length > 1 && (
          <div className="flex rounded-lg border border-border bg-surface-2 p-0.5">
            {scopes.map((s) => (
              <Link
                key={s.scope}
                href={s.href}
                aria-current={scope === s.scope ? 'page' : undefined}
                className={`min-h-11 flex-1 rounded-md py-2.5 text-center font-mono text-[10px] uppercase tracking-widest transition-colors ${
                  scope === s.scope ? 'bg-surface text-text' : 'text-text-3 hover:text-text'
                }`}
              >
                {dict.rail[SCOPE_LABEL_KEY[s.scope]]}
              </Link>
            ))}
          </div>
        )}

        {scope === 'team' && teams.length > 1 && <TeamPicker current={activeTeam} teams={teams} />}

        {groups.map((group) => (
          <div key={group.labelKey} className="flex flex-col gap-0.5">
            <p className="px-2 pb-1.5 font-mono text-[9.5px] uppercase tracking-widest text-text-3">
              {dict.nav[group.labelKey]}
            </p>
            {group.items.map((item) => {
              const active = isActive(pathname, item);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={`relative flex min-h-11 items-center gap-2.5 rounded-md px-2 py-2 text-sm transition-colors ${
                    active
                      ? 'bg-accent-dim font-medium text-text before:absolute before:top-1.5 before:bottom-1.5 before:-left-3 before:w-0.5 before:rounded-r-sm before:bg-accent'
                      : 'text-text-2 hover:bg-surface-2 hover:text-text'
                  }`}
                >
                  <Icon size={14} className="shrink-0 opacity-80" />
                  {dict.nav[item.labelKey]}
                </Link>
              );
            })}
          </div>
        ))}

        {/* One account row, not one per breakpoint — a second copy would mean a
            second hydrated ThemeToggle and a second MutationObserver. Ordered
            first in the drawer, pinned last in the rail. */}
        <div className="flex items-center gap-2.5 px-2 max-lg:order-first max-lg:border-b max-lg:border-border max-lg:pb-3 lg:mt-auto lg:pt-4">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border bg-surface-2 font-mono text-[9px] text-text-2">
            {initials(userLabel)}
          </span>
          <span className="min-w-0 flex-1 truncate text-xs text-text-2" title={userLabel}>
            {userLabel}
          </span>
          <LocaleSwitcher />
          <ThemeToggle />
          <SignOutButton />
        </div>
      </nav>
    </>
  );
}

function TeamPicker({ current, teams }: { current: string | null; teams: RailTeam[] }) {
  const dict = useDict();
  return (
    <div className="px-1">
      <Select
        size="sm"
        className="w-full"
        aria-label={dict.common.team}
        value={current ?? ''}
        onChange={(e) => {
          window.location.href = `/team/${e.target.value}`;
        }}
      >
        {teams.map((t) => (
          <option key={t.githubSlug} value={t.githubSlug}>
            {t.name}
          </option>
        ))}
      </Select>
    </div>
  );
}
