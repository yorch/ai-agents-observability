'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const ME_NAV = [
  { exact: true, href: '/me', label: 'Overview' },
  { exact: false, href: '/me/sessions', label: 'Sessions' },
  { exact: false, href: '/me/insights', label: 'Insights' },
  { exact: false, href: '/me/prs', label: 'Pull Requests' },
  { exact: false, href: '/me/search', label: 'Search' },
  { exact: false, href: '/me/privacy', label: 'Privacy' },
  { exact: false, href: '/me/audit', label: 'Audit log' },
];

export function MeNav() {
  const pathname = usePathname();
  return (
    <nav className="mb-6 flex gap-6 border-b border-white/10">
      {ME_NAV.map(({ exact, href, label }) => {
        const active = exact ? pathname === href : pathname.startsWith(href);
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
