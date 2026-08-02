'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { LockIcon, LogIcon, UserIcon } from '@/components/icons';

const NAV_ITEMS = [
  { href: '/me/settings/profile', icon: UserIcon, label: 'Profile' },
  { href: '/me/settings/privacy', icon: LockIcon, label: 'Privacy' },
  { href: '/me/settings/audit', icon: LogIcon, label: 'Audit log' },
];

export function SettingsNav() {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col gap-0.5 w-48 shrink-0">
      {NAV_ITEMS.map(({ href, icon: Icon, label }) => {
        const isActive = pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            className={`flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors ${
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
