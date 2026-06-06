import type { User } from '@ai-agents-observability/db';
import { TeamRole } from '@ai-agents-observability/db';
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
export async function requireTeamLead(slug: string): Promise<TeamContext> {
  const user = await currentUser();
  if (!user) {
    redirect('/login');
  }

  const team = await resolveTeam(slug);
  const membership = await resolveActiveMembership(team.id, user.id);

  if (!membership || !LEAD_ROLES.includes(membership.roleInTeam)) {
    notFound();
  }

  return {
    role: membership.roleInTeam,
    teamId: team.id,
    teamName: team.name,
    teamSlug: team.githubSlug,
    user,
  };
}

/**
 * Asserts authenticated and is an active member of the team (any role).
 * Redirects to /login if unauthenticated; 404 if team missing or user not a member.
 */
export async function requireTeamMember(slug: string): Promise<TeamContext> {
  const user = await currentUser();
  if (!user) {
    redirect('/login');
  }

  const team = await resolveTeam(slug);
  const membership = await resolveActiveMembership(team.id, user.id);

  if (!membership) {
    notFound();
  }

  return {
    role: membership.roleInTeam,
    teamId: team.id,
    teamName: team.name,
    teamSlug: team.githubSlug,
    user,
  };
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
