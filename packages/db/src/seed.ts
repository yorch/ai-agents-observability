import { faker } from '@faker-js/faker';
import { createClient } from './index';

const SEED_EMAIL = 'demo@example.com';
const DEMO_USER_LOGIN = 'demo-dev';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required');
}
const db = createClient(DATABASE_URL);

async function main() {
  // Cleanup in FK-safe order: sessions (no cascade from user) → repos (cascade PRs/rollups) → user → team
  const existing = await db.user.findUnique({ where: { githubLogin: DEMO_USER_LOGIN } });
  if (existing) {
    await db.session.deleteMany({ where: { userId: existing.id } });
  }
  await db.repo.deleteMany({ where: { githubOwner: 'demo-org' } });
  if (existing) {
    await db.user.delete({ where: { id: existing.id } });
  }
  const existingTeam = await db.team.findUnique({ where: { githubSlug: 'demo-org' } });
  if (existingTeam) {
    await db.team.delete({ where: { id: existingTeam.id } });
  }

  // Team
  const team = await db.team.create({
    data: {
      githubId: BigInt(1234567),
      githubSlug: 'demo-org',
      name: 'Demo Org',
      syncedAt: new Date(),
    },
  });

  // User
  const user = await db.user.create({
    data: {
      createdAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
      displayName: 'Demo Dev',
      email: SEED_EMAIL,
      githubId: BigInt(9876543),
      githubLogin: DEMO_USER_LOGIN,
      lastSeenAt: new Date(),
      primaryTeamId: team.id,
    },
  });

  // TeamMember
  await db.teamMember.create({
    data: { roleInTeam: 'member', teamId: team.id, userId: user.id },
  });

  // VisibilityPolicy — transcripts off by default per §10
  await db.visibilityPolicy.create({
    data: {
      shareMetadataWithOrg: true,
      shareMetadataWithTeam: true,
      shareTranscriptsWithOrg: false,
      shareTranscriptsWithTeam: false,
      userId: user.id,
    },
  });

  // Repo
  const repo = await db.repo.create({
    data: {
      defaultBranch: 'main',
      githubId: BigInt(555666777),
      githubName: 'demo-app',
      githubOwner: 'demo-org',
      owningTeamId: team.id,
    },
  });

  // Sessions — 30 days × 3/day = 90
  const sessions: string[] = [];
  const now = Date.now();
  const PRICE_PER_MTOK = { cache_read: 0.3, cache_write: 3.75, input: 3.0, output: 15.0 };

  for (let day = 29; day >= 0; day--) {
    for (let i = 0; i < 3; i++) {
      const startedAt = new Date(
        now - day * 24 * 60 * 60 * 1000 - faker.number.int({ max: 8 * 60 * 60 * 1000, min: 0 }),
      );
      // Long-tail distribution: most sessions 5–30 min, a few multi-hour
      const durationMs = faker.helpers.weightedArrayElement([
        { value: faker.number.int({ max: 30, min: 5 }) * 60 * 1000, weight: 60 },
        { value: faker.number.int({ max: 120, min: 30 }) * 60 * 1000, weight: 30 },
        { value: faker.number.int({ max: 360, min: 120 }) * 60 * 1000, weight: 10 },
      ]);
      const endedAt = new Date(startedAt.getTime() + durationMs);
      const inputTokens = faker.number.int({ max: 50000, min: 1000 });
      const outputTokens = faker.number.int({ max: 10000, min: 500 });
      const cacheRead = faker.number.int({ max: 20000, min: 0 });
      const cacheCreation = faker.number.int({ max: 5000, min: 0 });
      const costUsd =
        (inputTokens * PRICE_PER_MTOK.input +
          outputTokens * PRICE_PER_MTOK.output +
          cacheRead * PRICE_PER_MTOK.cache_read +
          cacheCreation * PRICE_PER_MTOK.cache_write) /
        1_000_000;
      const toolCalls = faker.number.int({ max: 80, min: 5 });

      const session = await db.session.create({
        data: {
          agentType: 'claude_code',
          agentVersion: '1.0.0',
          claudeCodeVersion: '1.0.0',
          cwd: `/home/${DEMO_USER_LOGIN}/projects/demo-app`,
          endedAt,
          gitBranch: faker.helpers.arrayElement([
            'main',
            'feat/new-feature',
            'fix/bug-123',
            'chore/deps',
          ]),
          gitCommit: faker.git.commitSha({ length: 40 }),
          lastEventAt: endedAt,
          os: faker.helpers.arrayElement(['darwin', 'linux']),
          permissionDenyCount: faker.number.int({ max: 2, min: 0 }),
          permissionPromptCount: faker.number.int({ max: 5, min: 0 }),
          primaryModel: 'claude-sonnet-4-6',
          repoId: repo.id,
          sessionId: faker.string.uuid(),
          startedAt,
          status: 'completed',
          toolCallCount: toolCalls,
          toolErrorCount: faker.number.int({ max: Math.floor(toolCalls * 0.1), min: 0 }),
          totalCacheCreation: BigInt(cacheCreation),
          totalCacheRead: BigInt(cacheRead),
          totalCostUsd: costUsd,
          totalInputTokens: BigInt(inputTokens),
          totalOutputTokens: BigInt(outputTokens),
          userId: user.id,
          userMessageCount: faker.number.int({ max: 20, min: 1 }),
        },
      });

      sessions.push(session.sessionId);

      // Insert 5–10 events per session into the hypertable via raw SQL
      const eventCount = faker.number.int({ max: 10, min: 5 });
      for (let e = 0; e < eventCount; e++) {
        const ts = new Date(startedAt.getTime() + e * Math.floor(durationMs / eventCount));
        const eventType = faker.helpers.arrayElement([
          'PreToolUse',
          'PostToolUse',
          'UserPromptSubmit',
          'SessionStart',
        ]);
        const eventId = crypto.randomUUID();
        await db.$executeRaw`
          INSERT INTO events (
            event_id, session_id, user_id, ts, agent_type, event_type,
            model, input_tokens, output_tokens, cost_usd, mode
          ) VALUES (
            ${eventId}::uuid, ${session.sessionId}::uuid, ${user.id}::uuid, ${ts},
            'claude_code', ${eventType},
            'claude-sonnet-4-6',
            ${faker.number.int({ max: 2000, min: 100 })},
            ${faker.number.int({ max: 500, min: 50 })},
            ${faker.number.float({ fractionDigits: 6, max: 0.05, min: 0.001 })},
            'normal'
          )
          ON CONFLICT (event_id) DO NOTHING
        `;
      }
    }
  }

  // Pull Requests — 5 total, 3 merged
  const prData = [
    { merged: true, number: 101, state: 'merged' as const, title: 'feat: add user dashboard' },
    { merged: true, number: 102, state: 'merged' as const, title: 'fix: token expiry check' },
    { merged: true, number: 103, state: 'merged' as const, title: 'chore: update deps' },
    { merged: false, number: 104, state: 'open' as const, title: 'feat: team view' },
    { merged: false, number: 105, state: 'closed' as const, title: 'refactor: cleanup' },
  ];

  for (const pr of prData) {
    const openedAt = new Date(now - faker.number.int({ max: 20, min: 5 }) * 24 * 60 * 60 * 1000);
    const mergedAt = pr.merged
      ? new Date(openedAt.getTime() + faker.number.int({ max: 3, min: 1 }) * 24 * 60 * 60 * 1000)
      : null;
    const closedAt =
      pr.state !== 'open' ? (mergedAt ?? new Date(openedAt.getTime() + 24 * 60 * 60 * 1000)) : null;

    await db.pullRequest.create({
      data: {
        authorGithubLogin: DEMO_USER_LOGIN,
        authorUserId: user.id,
        baseBranch: 'main',
        closedAt,
        filesChanged: faker.number.int({ max: 20, min: 1 }),
        githubId: BigInt(10000000 + pr.number),
        headBranch: `feat/pr-${pr.number}`,
        labels: [],
        linesAdded: faker.number.int({ max: 500, min: 10 }),
        linesRemoved: faker.number.int({ max: 200, min: 0 }),
        mergedAt,
        openedAt,
        prNumber: pr.number,
        repoId: repo.id,
        reviewCount: faker.number.int({ max: 4, min: 1 }),
        reviewerLogins: ['reviewer-a', 'reviewer-b'],
        state: pr.state === 'merged' ? 'merged' : pr.state === 'closed' ? 'closed' : 'open',
        title: pr.title,
      },
    });

    // Link 2 sessions to each PR
    const linkedSessions = faker.helpers.arrayElements(sessions, 2);
    for (const sessionId of linkedSessions) {
      await db.sessionPRLink.upsert({
        create: { linkSource: 'session_start', prNumber: pr.number, repoId: repo.id, sessionId },
        update: {},
        where: { sessionId_repoId_prNumber: { prNumber: pr.number, repoId: repo.id, sessionId } },
      });
    }

    // PRRollup for merged PRs
    if (pr.merged && mergedAt) {
      await db.pRRollup.create({
        data: {
          contributingSessionIds: linkedSessions,
          contributingUserIds: [user.id],
          costPerLoc: faker.number.float({ fractionDigits: 6, max: 0.05, min: 0.001 }),
          firstSessionAt: openedAt,
          lastSessionAt: mergedAt,
          prNumber: pr.number,
          repoId: repo.id,
          totalActiveSeconds: faker.number.int({ max: 7200, min: 600 }),
          totalCostUsd: faker.number.float({ fractionDigits: 6, max: 2.0, min: 0.01 }),
          totalInputTokens: BigInt(faker.number.int({ max: 50000, min: 5000 })),
          totalOutputTokens: BigInt(faker.number.int({ max: 10000, min: 1000 })),
          totalPermissionDenies: faker.number.int({ max: 5, min: 0 }),
          totalToolCalls: faker.number.int({ max: 200, min: 20 }),
          totalToolErrors: faker.number.int({ max: 10, min: 0 }),
        },
      });
    }
  }

  console.log(
    `Seed complete. Created: 1 team, 1 user, 1 repo, ${sessions.length} sessions, 5 PRs.`,
  );
  await db.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
