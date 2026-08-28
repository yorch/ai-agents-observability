import type { ComponentType } from 'react';

import {
  AgentIcon,
  BarsIcon,
  BellIcon,
  BookIcon,
  ChartIcon,
  ClockIcon,
  CodeIcon,
  CubeIcon,
  GaugeIcon,
  GearIcon,
  KeyIcon,
  ListIcon,
  PeopleIcon,
  PolicyIcon,
  PullRequestIcon,
  SearchIcon,
  ShieldIcon,
  SparkleIcon,
  StackIcon,
  StarIcon,
  TargetIcon,
} from '@/components/icons';

export type Scope = 'me' | 'team' | 'org' | 'admin';

export type NavItem = {
  /** Match the pathname exactly rather than by prefix — for section roots. */
  exact?: boolean;
  href: string;
  icon: ComponentType<{ size?: number; className?: string }>;
  label: string;
};

export type NavGroup = { items: NavItem[]; label: string };

/**
 * The rail's contents, per scope. This replaces the three stacked horizontal
 * bars the app used to carry (global nav → section sub-nav → page tabs): the
 * sixteen org sections no longer compete for one row, and grouping them makes
 * the shape of each scope legible at a glance.
 */
export function meNav(showGrants: boolean): NavGroup[] {
  return [
    {
      items: [
        { exact: true, href: '/me', icon: ChartIcon, label: 'Overview' },
        { href: '/me/sessions', icon: ListIcon, label: 'Sessions' },
        { href: '/me/insights', icon: GaugeIcon, label: 'Insights' },
        { href: '/me/trends', icon: ChartIcon, label: 'Trends' },
        { href: '/me/report', icon: ChartIcon, label: 'Report' },
        { href: '/me/prs', icon: PullRequestIcon, label: 'Pull requests' },
        { href: '/me/search', icon: SearchIcon, label: 'Search' },
      ],
      label: 'My agents',
    },
    {
      items: [
        ...(showGrants ? [{ href: '/me/grants', icon: KeyIcon, label: 'Grants' }] : []),
        { href: '/me/settings', icon: GearIcon, label: 'Settings' },
      ],
      label: 'Account',
    },
  ];
}

export function teamNav(slug: string): NavGroup[] {
  const base = `/team/${slug}`;
  return [
    {
      items: [
        { exact: true, href: base, icon: ChartIcon, label: 'Overview' },
        { href: `${base}/roster`, icon: PeopleIcon, label: 'Roster' },
        { href: `${base}/sessions`, icon: ListIcon, label: 'Sessions' },
        { href: `${base}/prs`, icon: PullRequestIcon, label: 'Pull requests' },
        { href: `${base}/report`, icon: ChartIcon, label: 'Report' },
        { href: `${base}/trends`, icon: ChartIcon, label: 'Trends' },
      ],
      label: 'Team',
    },
    {
      items: [
        { href: `${base}/adoption`, icon: BarsIcon, label: 'Adoption' },
        { href: `${base}/agents`, icon: AgentIcon, label: 'Agents' },
        { href: `${base}/tools`, icon: CodeIcon, label: 'Tools' },
        { href: `${base}/mcp`, icon: StackIcon, label: 'MCP' },
        { href: `${base}/skills`, icon: StarIcon, label: 'Skills' },
      ],
      label: 'Usage',
    },
  ];
}

export const ORG_NAV: NavGroup[] = [
  {
    items: [
      { href: '/org/dashboard', icon: ChartIcon, label: 'Dashboard' },
      { href: '/org/adoption', icon: BarsIcon, label: 'Adoption' },
      { href: '/org/delivery', icon: ClockIcon, label: 'Delivery' },
      { href: '/org/roi', icon: GaugeIcon, label: 'ROI' },
      { href: '/org/quality', icon: SparkleIcon, label: 'Quality' },
      { href: '/org/benchmarks', icon: TargetIcon, label: 'Benchmarks' },
      { href: '/org/report', icon: ChartIcon, label: 'Report' },
      { href: '/org/trends', icon: ChartIcon, label: 'Trends' },
    ],
    label: 'Overview',
  },
  {
    items: [
      { href: '/org/agents', icon: AgentIcon, label: 'Agents' },
      { href: '/org/tools', icon: CodeIcon, label: 'Tool usage' },
      { href: '/org/mcp', icon: StackIcon, label: 'MCP' },
      { href: '/org/models', icon: CubeIcon, label: 'Models' },
      { href: '/org/skills', icon: StarIcon, label: 'Skills' },
      { href: '/org/teams', icon: PeopleIcon, label: 'Teams' },
    ],
    label: 'Agents',
  },
  {
    items: [
      { href: '/org/governance', icon: PolicyIcon, label: 'Governance' },
      { href: '/org/security', icon: ShieldIcon, label: 'Security' },
      { href: '/org/knowledge', icon: BookIcon, label: 'Knowledge' },
      { href: '/org/search', icon: SearchIcon, label: 'Search' },
    ],
    label: 'Governance',
  },
];

export const ADMIN_NAV: NavGroup[] = [
  {
    items: [
      { href: '/admin/jobs', icon: ClockIcon, label: 'Jobs' },
      { href: '/admin/alerts', icon: BellIcon, label: 'Alerts' },
      { href: '/admin/adapters', icon: StackIcon, label: 'Adapters' },
    ],
    label: 'Operations',
  },
  {
    items: [
      { href: '/admin/org-roles', icon: KeyIcon, label: 'Org roles' },
      { href: '/admin/team-roles', icon: PeopleIcon, label: 'Team roles' },
      { href: '/admin/access-grants', icon: KeyIcon, label: 'Access grants' },
    ],
    label: 'Access',
  },
  {
    items: [
      { href: '/admin/retention', icon: ClockIcon, label: 'Retention' },
      { href: '/admin/price-tables', icon: StackIcon, label: 'Price tables' },
      { href: '/admin/model-policy', icon: PolicyIcon, label: 'Model policy' },
    ],
    label: 'Data',
  },
];

export function scopeOf(pathname: string): Scope | null {
  if (pathname.startsWith('/admin')) {
    return 'admin';
  }
  if (pathname.startsWith('/org')) {
    return 'org';
  }
  if (pathname.startsWith('/team/')) {
    return 'team';
  }
  if (pathname.startsWith('/me')) {
    return 'me';
  }
  return null;
}

/** `/team/acme/roster` → `acme`. */
export function teamSlugOf(pathname: string): string | null {
  return pathname.split('/')[2] ?? null;
}

export function isActive(pathname: string, item: NavItem): boolean {
  return item.exact ? pathname === item.href : pathname.startsWith(item.href);
}
