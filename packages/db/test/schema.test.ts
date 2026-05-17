import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../src/generated/client/client.js';

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('schema round-trip', () => {
  let prisma: PrismaClient;

  // Random suffix so re-runs against the same DB don't hit unique constraints
  const suffix = Math.random().toString(36).slice(2, 8);
  const githubIdBase = Math.floor(Math.random() * 1_000_000) + 100_000;

  beforeAll(() => {
    const adapter = new PrismaPg({ connectionString: DATABASE_URL as string });
    prisma = new PrismaClient({ adapter });
  });

  afterAll(async () => {
    // Clean up in reverse FK order
    await prisma.pRRollup.deleteMany();
    await prisma.sessionPRLink.deleteMany();
    await prisma.pullRequest.deleteMany();
    await prisma.session.deleteMany();
    await prisma.auditLog.deleteMany();
    await prisma.visibilityPolicy.deleteMany();
    await prisma.authToken.deleteMany();
    await prisma.repo.deleteMany();
    await prisma.teamMember.deleteMany();
    await prisma.user.deleteMany();
    await prisma.team.deleteMany();
    await prisma.$disconnect();
  });

  let teamId: string;
  let userId: string;
  let repoId: string;
  let sessionId: string;

  it('creates and reads a Team', async () => {
    const team = await prisma.team.create({
      data: {
        githubId: BigInt(githubIdBase),
        githubSlug: `test-team-${suffix}`,
        name: 'Test Team',
      },
    });
    teamId = team.id;
    expect(team.githubSlug).toBe(`test-team-${suffix}`);
    expect(team.id).toBeTruthy();
  });

  it('creates and reads a User', async () => {
    const user = await prisma.user.create({
      data: {
        displayName: 'Test User',
        email: `test-${suffix}@example.com`,
        githubId: BigInt(githubIdBase + 1),
        githubLogin: `testuser-${suffix}`,
        primaryTeamId: teamId,
      },
    });
    userId = user.id;
    expect(user.githubLogin).toBe(`testuser-${suffix}`);
    expect(user.primaryTeamId).toBe(teamId);
  });

  it('creates and reads a TeamMember', async () => {
    const member = await prisma.teamMember.create({
      data: { roleInTeam: 'member', teamId, userId },
    });
    expect(member.teamId).toBe(teamId);
    expect(member.userId).toBe(userId);
  });

  it('creates and reads a Repo', async () => {
    const repo = await prisma.repo.create({
      data: {
        githubName: `testrepo-${suffix}`,
        githubOwner: `testorg-${suffix}`,
        owningTeamId: teamId,
      },
    });
    repoId = repo.id;
    expect(repo.githubOwner).toBe(`testorg-${suffix}`);
  });

  it('creates and reads a VisibilityPolicy', async () => {
    const policy = await prisma.visibilityPolicy.create({
      data: { userId },
    });
    expect(policy.userId).toBe(userId);
    expect(policy.shareMetadataWithTeam).toBe(true);
    expect(policy.shareTranscriptsWithOrg).toBe(false);
  });

  it('creates and reads an AuthToken', async () => {
    const token = await prisma.authToken.create({
      data: { kind: 'hook', tokenHash: `sha256:${suffix}`, userId },
    });
    expect(token.kind).toBe('hook');
    expect(token.userId).toBe(userId);
  });

  it('creates and reads an AuditLog entry', async () => {
    const entry = await prisma.auditLog.create({
      data: {
        action: 'view_session',
        actorUserId: userId,
        justification: 'integration test',
        targetUserId: userId,
      },
    });
    expect(entry.action).toBe('view_session');
    expect(typeof entry.id).toBe('bigint');
  });

  it('creates and reads a Session', async () => {
    const now = new Date();
    const sid = crypto.randomUUID();
    const session = await prisma.session.create({
      data: {
        lastEventAt: now,
        repoId,
        sessionId: sid,
        startedAt: now,
        status: 'active',
        userId,
      },
    });
    sessionId = session.sessionId;
    expect(session.sessionId).toBe(sid);
    expect(session.agentType).toBe('claude_code');
    expect(session.totalCostUsd.toString()).toBe('0');
  });

  it('creates and reads a PullRequest', async () => {
    const pr = await prisma.pullRequest.create({
      data: {
        authorGithubLogin: `testuser-${suffix}`,
        githubId: BigInt(githubIdBase + 2),
        prNumber: 1,
        repoId,
        state: 'open',
      },
    });
    expect(pr.prNumber).toBe(1);
    expect(pr.state).toBe('open');
  });

  it('creates and reads a SessionPRLink', async () => {
    const link = await prisma.sessionPRLink.create({
      data: { linkSource: 'session_start', prNumber: 1, repoId, sessionId },
    });
    expect(link.linkSource).toBe('session_start');
  });

  it('creates and reads a PRRollup', async () => {
    const rollup = await prisma.pRRollup.create({
      data: { contributingUserIds: [userId], prNumber: 1, repoId },
    });
    expect(rollup.contributingUserIds).toContain(userId);
  });
});
