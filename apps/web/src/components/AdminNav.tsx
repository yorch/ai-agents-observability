'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const ADMIN_NAV = [
  { href: '/admin/jobs', label: 'Jobs' },
  { href: '/admin/org-roles', label: 'Org roles' },
  { href: '/admin/team-roles', label: 'Team roles' },
  { href: '/admin/alerts', label: 'Alerts' },
  { href: '/admin/access-grants', label: 'Access grants' },
  { href: '/admin/retention', label: 'Retention' },
  { href: '/admin/adapters', label: 'Adapters' },
  { href: '/admin/price-tables', label: 'Price tables' },
];

export function AdminNav() {
  const pathname = usePathname();
  return (
    <nav className="mb-8 flex flex-wrap border-b border-border text-sm">
      {ADMIN_NAV.map(({ href, label }) => {
        const isActive = pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            className={`relative mr-6 pb-3 transition-colors ${
              isActive
                ? 'text-text after:absolute after:bottom-[-1px] after:left-0 after:right-0 after:h-px after:bg-accent'
                : 'text-text-2 hover:text-text'
            }`}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
