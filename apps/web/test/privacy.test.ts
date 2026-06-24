import * as fc from 'fast-check';
import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  process.env.DATABASE_URL = 'postgresql://test:test@x:5432/x';
});

// ── Mock @ai-agents-observability/db ────────────────────────────────────────

const mockTeamMemberFindMany = vi.fn();
const mockTeamMemberFindFirst = vi.fn();
const mockSessionGroupBy = vi.fn();

const mockPrisma = {
  session: { groupBy: mockSessionGroupBy },
  teamMember: { findFirst: mockTeamMemberFindFirst, findMany: mockTeamMemberFindMany },
  visibilityPolicy: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
};

vi.mock('@ai-agents-observability/db', () => ({
  createClient: vi.fn(() => mockPrisma),
  Prisma: {},
  TeamRole: { LEAD: 'LEAD', MAINTAINER: 'MAINTAINER', MEMBER: 'MEMBER' },
}));

// ── getVisibilityPolicy ──────────────────────────────────────────────────────

describe('getVisibilityPolicy', () => {
  it('returns null when no policy exists', async () => {
    mockPrisma.visibilityPolicy.findUnique.mockResolvedValueOnce(null);
    const { getVisibilityPolicy } = await import('../src/lib/visibility.js');
    const result = await getVisibilityPolicy('u1');
    expect(result).toBeNull();
  });

  it('returns existing policy', async () => {
    const policy = {
      shareMetadataWithOrg: false,
      shareMetadataWithTeam: true,
      shareTranscriptsWithOrg: false,
      shareTranscriptsWithTeam: false,
      updatedAt: new Date(),
      userId: 'u1',
    };
    mockPrisma.visibilityPolicy.findUnique.mockResolvedValueOnce(policy);
    const { getVisibilityPolicy } = await import('../src/lib/visibility.js');
    const result = await getVisibilityPolicy('u1');
    expect(result?.shareMetadataWithTeam).toBe(true);
    expect(result?.shareMetadataWithOrg).toBe(false);
  });
});

// ── updateVisibilityPolicy ───────────────────────────────────────────────────

describe('updateVisibilityPolicy', () => {
  it('upserts with provided values', async () => {
    const updatedPolicy = {
      shareMetadataWithOrg: false,
      shareMetadataWithTeam: false,
      shareTranscriptsWithOrg: false,
      shareTranscriptsWithTeam: true,
      updatedAt: new Date(),
      userId: 'u1',
    };
    mockPrisma.visibilityPolicy.upsert.mockResolvedValueOnce(updatedPolicy);

    const { updateVisibilityPolicy } = await import('../src/lib/visibility.js');
    const result = await updateVisibilityPolicy('u1', {
      shareMetadataWithTeam: false,
      shareTranscriptsWithTeam: true,
    });

    expect(mockPrisma.visibilityPolicy.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'u1' },
      }),
    );
    expect(result.shareTranscriptsWithTeam).toBe(true);
  });

  it('uses create defaults for new policies', async () => {
    const newPolicy = {
      shareMetadataWithOrg: true,
      shareMetadataWithTeam: true,
      shareTranscriptsWithOrg: false,
      shareTranscriptsWithTeam: false,
      updatedAt: new Date(),
      userId: 'u2',
    };
    mockPrisma.visibilityPolicy.upsert.mockResolvedValueOnce(newPolicy);

    const { updateVisibilityPolicy } = await import('../src/lib/visibility.js');
    await updateVisibilityPolicy('u2', {});

    const call = mockPrisma.visibilityPolicy.upsert.mock.calls.at(-1)?.[0];
    // create block should have default values
    expect(call.create.shareMetadataWithTeam).toBe(true);
    expect(call.create.shareTranscriptsWithTeam).toBe(false);
  });
});

// ── P3-006: fast-check property-based access control tests ───────────────────

function makeMembership(opts: {
  displayName?: string | null;
  githubLogin?: string;
  roleInTeam?: string;
  shareMetadataWithTeam?: boolean;
  shareTranscriptsWithTeam?: boolean;
  userId?: string;
}) {
  return {
    roleInTeam: opts.roleInTeam ?? 'MEMBER',
    user: {
      displayName: opts.displayName ?? null,
      githubLogin: opts.githubLogin ?? 'testuser',
      visibilityPolicy: {
        shareMetadataWithTeam: opts.shareMetadataWithTeam ?? true,
        shareTranscriptsWithTeam: opts.shareTranscriptsWithTeam ?? false,
      },
    },
    userId: opts.userId ?? 'user-1',
  };
}

describe('privacy enforcement — property tests (≥200 runs each)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as Record<string, unknown>)._prisma = undefined;
  });

  it('shareMetadataWithTeam=false → no cost/session stats in roster result', async () => {
    const { getTeamRoster } = await import('../src/lib/team-queries.js');

    await fc.assert(
      fc.asyncProperty(
        fc.record({
          displayName: fc.option(fc.string({ maxLength: 20 }), { nil: null }),
          githubLogin: fc.string({ maxLength: 15, minLength: 1 }),
          shareMetadataWithTeam: fc.boolean(),
          userId: fc.uuid(),
        }),
        async (member) => {
          vi.clearAllMocks();
          (globalThis as Record<string, unknown>)._prisma = undefined;

          mockTeamMemberFindMany.mockResolvedValueOnce([
            makeMembership({
              displayName: member.displayName,
              githubLogin: member.githubLogin,
              shareMetadataWithTeam: member.shareMetadataWithTeam,
              userId: member.userId,
            }),
          ]);
          if (member.shareMetadataWithTeam) {
            mockSessionGroupBy.mockResolvedValueOnce([]);
          }

          const roster = await getTeamRoster('team-id', new Date());
          const found = roster.find((m) => m.userId === member.userId);

          expect(found).toBeDefined();
          if (!member.shareMetadataWithTeam) {
            expect(found?.canViewStats).toBe(false);
            expect(found?.sessionCount).toBeNull();
            expect(found?.totalCostUsd).toBeNull();
          } else {
            expect(found?.canViewStats).toBe(true);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('shareTranscriptsWithTeam=false → canViewTranscripts=false in getMemberForTeam', async () => {
    const { getMemberForTeam } = await import('../src/lib/team-queries.js');

    await fc.assert(
      fc.asyncProperty(
        fc.record({
          shareMetadataWithTeam: fc.boolean(),
          shareTranscriptsWithTeam: fc.boolean(),
          userId: fc.uuid(),
        }),
        async (member) => {
          vi.clearAllMocks();
          (globalThis as Record<string, unknown>)._prisma = undefined;

          mockTeamMemberFindFirst.mockResolvedValueOnce(
            makeMembership({
              shareMetadataWithTeam: member.shareMetadataWithTeam,
              shareTranscriptsWithTeam: member.shareTranscriptsWithTeam,
              userId: member.userId,
            }),
          );

          const profile = await getMemberForTeam('team-id', 'testuser');

          expect(profile).not.toBeNull();
          expect(profile?.canViewTranscripts).toBe(member.shareTranscriptsWithTeam);
          expect(profile?.canViewStats).toBe(member.shareMetadataWithTeam);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('cross-team isolation: getMemberForTeam returns null for user not in team', async () => {
    const { getMemberForTeam } = await import('../src/lib/team-queries.js');

    await fc.assert(
      fc.asyncProperty(
        fc.record({
          login: fc.string({ maxLength: 20, minLength: 1 }),
          teamId: fc.uuid(),
        }),
        async ({ login, teamId }) => {
          vi.clearAllMocks();
          (globalThis as Record<string, unknown>)._prisma = undefined;

          // DB returns null: user is not an active member of this team.
          mockTeamMemberFindFirst.mockResolvedValueOnce(null);

          const profile = await getMemberForTeam(teamId, login);

          expect(profile).toBeNull();
        },
      ),
      { numRuns: 200 },
    );
  });

  it('member-role rejected, lead/maintainer accepted by isLeadOrAbove', async () => {
    const { isLeadOrAbove } = await import('../src/lib/roles.js');

    await fc.assert(
      fc.property(fc.constantFrom('LEAD', 'MAINTAINER', 'MEMBER'), (role) => {
        if (role === 'LEAD' || role === 'MAINTAINER') {
          return isLeadOrAbove(role as never);
        }
        return !isLeadOrAbove(role as never);
      }),
      { numRuns: 200 },
    );
  });
});
