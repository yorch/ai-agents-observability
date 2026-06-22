import type { User } from '@ai-agents-observability/db';
import { OrgRole, TeamRole } from '@ai-agents-observability/db';
import { notFound, redirect } from 'next/navigation';
import { currentUser } from './auth';
import { getPrisma } from './prisma';

export type TeamContext = {
  role: TeamRole;
  teamId: string;
  teamName: string;
  teamSlug: string;
  user: User;
};

const LEAD_ROLES: TeamRole[] = [TeamRole.lead, TeamRole.maintainer];

async function resolveTeam(slug: string) {
  const team = await getPrisma().team.findUnique({
    select: { githubSlug: true, id: true, name: true },
    where: { githubSlug: slug },
  });
  if (!team) {
    notFound();
  }
  return team;
}

async function resolveActiveMembership(teamId: string, userId: string) {
  const m = await getPrisma().teamMember.findUnique({
    select: { leftAt: true, roleInTeam: true },
    where: { teamId_userId: { teamId, userId } },
  });
  return m && !m.leftAt ? m : null;
}

/**
 * Asserts authenticated and holds lead or maintainer role in the given team.
 * Redirects to /login if unauthenticated; 404 if team missing or user is not a lead.
 */
async function requireTeamRole(
  slug: string,
  check: (role: TeamRole) => boolean,
): Promise<TeamContext> {
  const user = await currentUser();
  if (!user) {
    redirect('/login');
  }

  const team = await resolveTeam(slug);
  const membership = await resolveActiveMembership(team.id, user.id);

  // Org admins may view any team (consistent with canViewIndividuals) without a
  // team membership. Non-admins must be active members passing the role check.
  const isAdmin = user.orgRole === OrgRole.org_admin;
  if (!isAdmin && (!membership || !check(membership.roleInTeam))) {
    notFound();
  }

  return {
    role: membership?.roleInTeam ?? TeamRole.lead,
    teamId: team.id,
    teamName: team.name,
    teamSlug: team.githubSlug,
    user,
  };
}

export function requireTeamLead(slug: string): Promise<TeamContext> {
  return requireTeamRole(slug, isLeadOrAbove);
}

/**
 * Asserts authenticated and is an active member of the team (any role).
 * Redirects to /login if unauthenticated; 404 if team missing or user not a member.
 */
export function requireTeamMember(slug: string): Promise<TeamContext> {
  return requireTeamRole(slug, () => true);
}

/**
 * Returns the caller's role in a team, or null if not an active member.
 * Pure lookup — no redirect. Use for conditional rendering inside a page.
 */
export async function getTeamRole(userId: string, teamId: string): Promise<TeamRole | null> {
  const membership = await resolveActiveMembership(teamId, userId);
  return membership?.roleInTeam ?? null;
}

export function isLeadOrAbove(role: TeamRole): boolean {
  return LEAD_ROLES.includes(role);
}

// ── Org-level role helpers ────────────────────────────────────────────────────

export type OrgContext = {
  orgRole: OrgRole;
  user: User;
};

/**
 * Asserts the caller has org_admin role.
 * Redirects to /login if unauthenticated; 404 if insufficient role.
 */
export async function requireOrgAdmin(): Promise<OrgContext> {
  const user = await currentUser();
  if (!user) {
    redirect('/login');
  }
  if (user.orgRole !== OrgRole.org_admin) {
    notFound();
  }
  return { orgRole: user.orgRole, user };
}

/**
 * Asserts the caller has org_admin or viewer_aggregate role.
 * Redirects to /login if unauthenticated; 404 if insufficient role.
 */
export async function requireOrgViewer(): Promise<OrgContext> {
  const user = await currentUser();
  if (!user) {
    redirect('/login');
  }
  if (user.orgRole === OrgRole.member) {
    notFound();
  }
  return { orgRole: user.orgRole, user };
}

export function isOrgAdmin(role: OrgRole): boolean {
  return role === OrgRole.org_admin;
}

export function canViewIndividuals(role: OrgRole): boolean {
  return role === OrgRole.org_admin;
}
