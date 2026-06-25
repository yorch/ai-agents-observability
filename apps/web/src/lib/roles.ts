import type { PrismaClient, User } from '@ai-agents-observability/db';
import { OrgRole, TeamRole } from '@ai-agents-observability/db';
import { notFound, redirect } from 'next/navigation';
import { currentUser } from './auth';
import { grantCovers } from './grant-policy';
import { getPrisma } from './prisma';

export type TeamContext = {
  role: TeamRole;
  teamId: string;
  teamName: string;
  teamSlug: string;
  user: User;
};

export const LEAD_ROLES: TeamRole[] = [TeamRole.LEAD, TeamRole.MAINTAINER];

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
  const isAdmin = user.orgRole === OrgRole.ORG_ADMIN;
  if (!isAdmin && (!membership || !check(membership.roleInTeam))) {
    notFound();
  }

  return {
    role: membership?.roleInTeam ?? TeamRole.LEAD,
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
  if (user.orgRole !== OrgRole.ORG_ADMIN) {
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
  if (user.orgRole === OrgRole.MEMBER) {
    notFound();
  }
  return { orgRole: user.orgRole, user };
}

export function isOrgAdmin(role: OrgRole): boolean {
  return role === OrgRole.ORG_ADMIN;
}

export function canViewIndividuals(role: OrgRole): boolean {
  // Investigators are deliberately NOT here — they reach individual sessions ONLY
  // through an active access grant (hasActiveGrant), never standing. See below.
  return role === OrgRole.ORG_ADMIN;
}

/**
 * Who may *request* a time-boxed access grant (P9-003/P9-005): org_admins and
 * investigators (Audience B). viewer_aggregate cannot.
 *
 * TRUST RATIONALE — do not "simplify" investigator into standing individual
 * access. The project's posture (DESIGN_DOC §8/§11) requires access to another
 * person's session content to be requested-with-justification, org_admin-approved,
 * time-boxed, and visible to the viewed user. A standing role satisfies none of
 * these. Investigators therefore can only REQUEST grants; the grant (approved +
 * expiring + audited) is the access path, and when it expires `hasActiveGrant`
 * returns false and access reverts to aggregate-only with no code change.
 */
export function canRequestGrants(role: OrgRole): boolean {
  return role === OrgRole.ORG_ADMIN || role === OrgRole.INVESTIGATOR;
}

/** Asserts the caller may request access grants (org_admin or investigator). */
export async function requireGrantRequester(): Promise<OrgContext> {
  const user = await currentUser();
  if (!user) {
    redirect('/login');
  }
  if (!canRequestGrants(user.orgRole)) {
    notFound();
  }
  return { orgRole: user.orgRole, user };
}

/**
 * Whether `granteeId` holds an active, scope-covering access grant for the target
 * (P9-003, DESIGN_DOC §8.4). This is the gate for viewing a non-sharing user's
 * transcript: pass the session's owner as `targetUserId` and the session id as
 * `targetSessionId` so either a `user_sessions` or a `single_session` grant can
 * match. The active window (approved, not revoked, not expired) is enforced in the
 * query; `grantCovers` decides scope. An expired grant is treated exactly like no
 * grant — callers must not branch on "grant existed but expired".
 */
export async function hasActiveGrant(
  db: Pick<PrismaClient, 'accessGrant'>,
  target: { granteeId: string; targetSessionId?: string; targetUserId?: string },
): Promise<boolean> {
  const grants = await db.accessGrant.findMany({
    select: { scope: true, targetSessionId: true, targetUserId: true },
    where: {
      expiresAt: { gt: new Date() },
      grantedAt: { not: null },
      granteeUserId: target.granteeId,
      revokedAt: null,
    },
  });
  return grants.some((g) => grantCovers(g, target));
}

/**
 * How (if at all) `user` may view one other user's individual session — the
 * single decision shared by the org session-detail page, transcript page, and
 * transcript API route (DESIGN_DOC §8.4):
 *   - 'admin': org_admin standing access. Transcript content still needs the
 *     owner's opt-in OR a written justification, recorded loudly on the audit row.
 *   - 'grant': a non-admin (investigator) holding an active, scope-covering access
 *     grant. The approved, time-boxed grant IS the authorization, so transcript
 *     content needs no extra per-view justification.
 *   - null: no access — callers map to 404 (page) / 403 (API).
 * Pure decision (no redirect/throw) so each caller controls its own response.
 */
export async function resolveOrgSessionAccess(
  user: Pick<User, 'id' | 'orgRole'>,
  target: { ownerUserId: string; sessionId: string },
): Promise<'admin' | 'grant' | null> {
  if (canViewIndividuals(user.orgRole)) {
    return 'admin';
  }
  // Any user (including regular MEMBER) may reach a session via an active grant —
  // either an admin-requested+approved grant or an owner-initiated share.
  if (
    await hasActiveGrant(getPrisma(), {
      granteeId: user.id,
      targetSessionId: target.sessionId,
      targetUserId: target.ownerUserId,
    })
  ) {
    return 'grant';
  }
  return null;
}
