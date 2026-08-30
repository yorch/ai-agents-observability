'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { KeyIcon, LockIcon, LogIcon, UserIcon } from '@/components/icons';

const NAV_ITEMS = [
  { href: '/me/settings/profile', icon: UserIcon, label: 'Profile' },
  { href: '/me/settings/privacy', icon: LockIcon, label: 'Privacy' },
  { href: '/me/settings/tokens', icon: KeyIcon, label: 'Tokens' },
  { href: '/me/settings/audit', icon: LogIcon, label: 'Audit log' },
];

export function SettingsNav() {
  const pathname = usePathname();

  return (
    // A row of pills on phones (the 192px sidebar left ~103px of content at
    // 375px wide); the stacked sidebar returns at md.
    <nav className="flex gap-0.5 overflow-x-auto md:w-48 md:shrink-0 md:flex-col md:overflow-visible">
      {NAV_ITEMS.map(({ href, icon: Icon, label }) => {
        const isActive = pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={isActive ? 'page' : undefined}
            className={`flex shrink-0 items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors ${
              isActive
                ? 'bg-accent-dim text-accent font-medium'
                : 'text-text-2 hover:text-text hover:bg-surface-2'
            }`}
          >
            <Icon size={15} />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
