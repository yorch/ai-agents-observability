'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const BASE_NAV = [
  { exact: true, href: '/me', label: 'Overview' },
  { exact: false, href: '/me/sessions', label: 'Sessions' },
  { exact: false, href: '/me/insights', label: 'Insights' },
  { exact: false, href: '/me/prs', label: 'Pull Requests' },
  { exact: false, href: '/me/search', label: 'Search' },
];

const GRANTS_ENTRY = { exact: false, href: '/me/grants', label: 'Grants' };

export function MeNav({ showGrants = false }: { showGrants?: boolean }) {
  const pathname = usePathname();
  const nav = showGrants ? [...BASE_NAV, GRANTS_ENTRY] : BASE_NAV;
  return (
    <nav className="mb-8 flex flex-wrap border-b border-border text-sm">
      {nav.map(({ exact, href, label }) => {
        const isActive = exact ? pathname === href : pathname.startsWith(href);
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
