import { describe, expect, it, vi } from 'vitest';

import { syncLoginTeams } from '../src/lib/sync-login-teams';

type Membership = Parameters<typeof syncLoginTeams>[2][number];

function membership(over: Partial<Membership> = {}): Membership {
  return {
    org: 'acme',
    role: 'member',
    team_github_id: 1,
    team_name: 'Engineering',
    team_slug: 'eng',
    ...over,
  };
}

function mockDb() {
  const teamMemberUpsert = vi.fn().mockResolvedValue({});
  const teamMemberUpdateMany = vi.fn().mockResolvedValue({ count: 0 });
  const db = {
    team: { upsert: vi.fn().mockResolvedValue({ id: 'team-1' }) },
    teamMember: { updateMany: teamMemberUpdateMany, upsert: teamMemberUpsert },
    // biome-ignore lint/suspicious/noExplicitAny: minimal PrismaClient stand-in for unit test
  } as any;
  return { db, teamMemberUpdateMany, teamMemberUpsert };
}

describe('syncLoginTeams', () => {
  it('does not overwrite roleInTeam on the update path (no login downgrade)', async () => {
    const { db, teamMemberUpsert } = mockDb();
    await syncLoginTeams(db, 'u1', [membership()]);
    expect(teamMemberUpsert).toHaveBeenCalledTimes(1);
    const arg = teamMemberUpsert.mock.calls[0][0];
    // create may set the role (first insert), but update must NOT — otherwise a
    // lead/maintainer is downgraded to 'member' on every sign-in.
    expect(arg.create.roleInTeam).toBe('member');
    expect(arg.update).not.toHaveProperty('roleInTeam');
  });

  it('does NOT soft-delete memberships when the membership list is empty', async () => {
    const { db, teamMemberUpdateMany, teamMemberUpsert } = mockDb();
    await syncLoginTeams(db, 'u1', []);
    // An ambiguous empty result must not wipe the user out of all teams.
    expect(teamMemberUpsert).not.toHaveBeenCalled();
    expect(teamMemberUpdateMany).not.toHaveBeenCalled();
  });

  it('reconciles departures via notIn the observed teams when non-empty', async () => {
    const { db, teamMemberUpdateMany } = mockDb();
    await syncLoginTeams(db, 'u1', [membership()]);
    expect(teamMemberUpdateMany).toHaveBeenCalledTimes(1);
    const where = teamMemberUpdateMany.mock.calls[0][0].where;
    expect(where.userId).toBe('u1');
    expect(where.teamId).toEqual({ notIn: ['team-1'] });
  });
});
