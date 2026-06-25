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
];

export function AdminNav() {
  const pathname = usePathname();
  return (
    <nav className="mb-6 flex flex-wrap gap-6 border-b border-white/10">
      {ADMIN_NAV.map(({ href, label }) => {
        const active = pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            className={`pb-3 text-sm transition-colors ${
              active
                ? 'border-b-2 border-brand-500 text-white'
                : 'text-white/50 hover:text-white/80'
            }`}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
