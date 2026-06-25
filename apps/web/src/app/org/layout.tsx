import Link from 'next/link';
import type { ReactNode } from 'react';

const NAV = [
  { href: '/org/dashboard', label: 'Dashboard' },
  { href: '/org/adoption', label: 'Adoption' },
  { href: '/org/delivery', label: 'Delivery' },
  { href: '/org/benchmarks', label: 'Benchmarks' },
  { href: '/org/tools', label: 'Tools' },
  { href: '/org/search', label: 'Search' },
];

export function OrgSubNav({ active }: { active: string }) {
  return (
    <nav className="flex gap-1 border-b border-white/10 pb-4">
      {NAV.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
            active === item.label.toLowerCase()
              ? 'bg-white/10 text-white'
              : 'text-white/50 hover:text-white hover:bg-white/5'
          }`}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}

export default function OrgLayout({ children }: { children: ReactNode }) {
  return <div className="mx-auto max-w-7xl space-y-6 px-4 py-8">{children}</div>;
}
