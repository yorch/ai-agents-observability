'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const NAV = [
  { href: '/org/dashboard', label: 'Dashboard' },
  { href: '/org/adoption', label: 'Adoption' },
  { href: '/org/delivery', label: 'Delivery' },
  { href: '/org/roi', label: 'ROI' },
  { href: '/org/benchmarks', label: 'Benchmarks' },
  { href: '/org/tools', label: 'Tool Usage' },
  { href: '/org/agents', label: 'Agents' },
  { href: '/org/mcp', label: 'MCP' },
  { href: '/org/models', label: 'Models' },
  { href: '/org/skills', label: 'Skills' },
  { href: '/org/teams', label: 'Teams' },
  { href: '/org/governance', label: 'Governance' },
  { href: '/org/search', label: 'Search' },
];

export function OrgSubNav() {
  const pathname = usePathname();
  return (
    <nav className="mb-6 flex gap-6 border-b border-white/10">
      {NAV.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className={`pb-3 text-sm transition-colors ${
            pathname.startsWith(item.href)
              ? 'border-b-2 border-brand-500 text-white'
              : 'text-white/50 hover:text-white/80'
          }`}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
