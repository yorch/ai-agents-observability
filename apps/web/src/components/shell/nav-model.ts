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
import type { Dictionary } from '@/i18n/dictionary';

export type Scope = 'me' | 'team' | 'org' | 'admin';

export type NavItem = {
  /** Match the pathname exactly rather than by prefix — for section roots. */
  exact?: boolean;
  href: string;
  icon: ComponentType<{ size?: number; className?: string }>;
  /** Key into `Dictionary.nav` — resolved to a label by the consumer. */
  labelKey: keyof Dictionary['nav'];
};

export type NavGroup = { items: NavItem[]; labelKey: keyof Dictionary['nav'] };

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
        { exact: true, href: '/me', icon: ChartIcon, labelKey: 'meOverview' },
        { href: '/me/sessions', icon: ListIcon, labelKey: 'meSessions' },
        { href: '/me/insights', icon: GaugeIcon, labelKey: 'meInsights' },
        { href: '/me/trends', icon: ChartIcon, labelKey: 'meTrends' },
        { href: '/me/report', icon: ChartIcon, labelKey: 'meReport' },
        { href: '/me/prs', icon: PullRequestIcon, labelKey: 'mePullRequests' },
        { href: '/me/search', icon: SearchIcon, labelKey: 'meSearch' },
      ],
      labelKey: 'meGroupMyAgents',
    },
    {
      items: [
        ...(showGrants
          ? [{ href: '/me/grants', icon: KeyIcon, labelKey: 'meGrants' as const }]
          : []),
        { href: '/me/settings', icon: GearIcon, labelKey: 'meSettings' },
      ],
      labelKey: 'meGroupAccount',
    },
  ];
}

export function teamNav(slug: string): NavGroup[] {
  const base = `/team/${slug}`;
  return [
    {
      items: [
        { exact: true, href: base, icon: ChartIcon, labelKey: 'teamOverview' },
        { href: `${base}/roster`, icon: PeopleIcon, labelKey: 'teamRoster' },
        { href: `${base}/sessions`, icon: ListIcon, labelKey: 'teamSessions' },
        { href: `${base}/prs`, icon: PullRequestIcon, labelKey: 'teamPullRequests' },
        { href: `${base}/report`, icon: ChartIcon, labelKey: 'teamReport' },
        { href: `${base}/trends`, icon: ChartIcon, labelKey: 'teamTrends' },
      ],
      labelKey: 'teamGroupTeam',
    },
    {
      items: [
        { href: `${base}/adoption`, icon: BarsIcon, labelKey: 'teamAdoption' },
        { href: `${base}/agents`, icon: AgentIcon, labelKey: 'teamAgents' },
        { href: `${base}/tools`, icon: CodeIcon, labelKey: 'teamTools' },
        { href: `${base}/mcp`, icon: StackIcon, labelKey: 'teamMcp' },
        { href: `${base}/skills`, icon: StarIcon, labelKey: 'teamSkills' },
      ],
      labelKey: 'teamGroupUsage',
    },
  ];
}

export const ORG_NAV: NavGroup[] = [
  {
    items: [
      { href: '/org/dashboard', icon: ChartIcon, labelKey: 'orgDashboard' },
      { href: '/org/adoption', icon: BarsIcon, labelKey: 'orgAdoption' },
      { href: '/org/delivery', icon: ClockIcon, labelKey: 'orgDelivery' },
      { href: '/org/roi', icon: GaugeIcon, labelKey: 'orgRoi' },
      { href: '/org/quality', icon: SparkleIcon, labelKey: 'orgQuality' },
      { href: '/org/benchmarks', icon: TargetIcon, labelKey: 'orgBenchmarks' },
      { href: '/org/report', icon: ChartIcon, labelKey: 'orgReport' },
      { href: '/org/trends', icon: ChartIcon, labelKey: 'orgTrends' },
    ],
    labelKey: 'orgGroupOverview',
  },
  {
    items: [
      { href: '/org/agents', icon: AgentIcon, labelKey: 'orgAgents' },
      { href: '/org/tools', icon: CodeIcon, labelKey: 'orgToolUsage' },
      { href: '/org/mcp', icon: StackIcon, labelKey: 'orgMcp' },
      { href: '/org/models', icon: CubeIcon, labelKey: 'orgModels' },
      { href: '/org/skills', icon: StarIcon, labelKey: 'orgSkills' },
      { href: '/org/teams', icon: PeopleIcon, labelKey: 'orgTeams' },
    ],
    labelKey: 'orgGroupAgents',
  },
  {
    items: [
      { href: '/org/governance', icon: PolicyIcon, labelKey: 'orgGovernance' },
      { href: '/org/security', icon: ShieldIcon, labelKey: 'orgSecurity' },
      { href: '/org/knowledge', icon: BookIcon, labelKey: 'orgKnowledge' },
      { href: '/org/search', icon: SearchIcon, labelKey: 'orgSearch' },
    ],
    labelKey: 'orgGroupGovernance',
  },
];

export const ADMIN_NAV: NavGroup[] = [
  {
    items: [
      { href: '/admin/jobs', icon: ClockIcon, labelKey: 'adminJobs' },
      { href: '/admin/alerts', icon: BellIcon, labelKey: 'adminAlerts' },
      { href: '/admin/adapters', icon: StackIcon, labelKey: 'adminAdapters' },
    ],
    labelKey: 'adminGroupOperations',
  },
  {
    items: [
      { href: '/admin/org-roles', icon: KeyIcon, labelKey: 'adminOrgRoles' },
      { href: '/admin/team-roles', icon: PeopleIcon, labelKey: 'adminTeamRoles' },
      { href: '/admin/access-grants', icon: KeyIcon, labelKey: 'adminAccessGrants' },
    ],
    labelKey: 'adminGroupAccess',
  },
  {
    items: [
      { href: '/admin/retention', icon: ClockIcon, labelKey: 'adminRetention' },
      { href: '/admin/price-tables', icon: StackIcon, labelKey: 'adminPriceTables' },
      { href: '/admin/model-policy', icon: PolicyIcon, labelKey: 'adminModelPolicy' },
    ],
    labelKey: 'adminGroupData',
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
