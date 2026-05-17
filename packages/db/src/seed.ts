import { faker } from '@faker-js/faker';
import { createClient } from './index.js';

const SEED_EMAIL = 'demo@example.com';
const DEMO_USER_LOGIN = 'demo-dev';

const db = createClient(process.env.DATABASE_URL!);

async function main() {
  // Cleanup existing seed data
  const existing = await db.user.findUnique({ where: { githubLogin: DEMO_USER_LOGIN } });
  if (existing) {
    // Cascade deletes handle sessions, tokens, etc.
    await db.user.delete({ where: { id: existing.id } });
  }
  const existingTeam = await db.team.findUnique({ where: { githubSlug: 'demo-org' } });
  if (existingTeam) {
    await db.team.delete({ where: { id: existingTeam.id } });
  }

  // Team
  const team = await db.team.create({
    data: {
      githubSlug: 'demo-org',
      githubId: BigInt(1234567),
      name: 'Demo Org',
      syncedAt: new Date(),
    },
  });

  // User
  const user = await db.user.create({
    data: {
      githubLogin: DEMO_USER_LOGIN,
      githubId: BigInt(9876543),
      email: SEED_EMAIL,
      displayName: 'Demo Dev',
      primaryTeamId: team.id,
      createdAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
      lastSeenAt: new Date(),
    },
  });

  // TeamMember
  await db.teamMember.create({
    data: { teamId: team.id, userId: user.id, roleInTeam: 'member' },
  });

  // VisibilityPolicy — transcripts off by default per §10
  await db.visibilityPolicy.create({
    data: {
      userId: user.id,
      shareMetadataWithTeam: true,
      shareMetadataWithOrg: true,
      shareTranscriptsWithTeam: false,
      shareTranscriptsWithOrg: false,
    },
  });

  // Repo
  const repo = await db.repo.create({
    data: {
      githubOwner: 'demo-org',
      githubName: 'demo-app',
      githubId: BigInt(555666777),
      defaultBranch: 'main',
      owningTeamId: team.id,
    },
  });

  // Sessions — 30 days × 3/day = 90
  const sessions: string[] = [];
  const now = Date.now();
  const PRICE_PER_MTOK = { input: 3.0, output: 15.0, cache_read: 0.30, cache_write: 3.75 };

  for (let day = 29; day >= 0; day--) {
    for (let i = 0; i < 3; i++) {
      const startedAt = new Date(now - (day * 24 * 60 * 60 * 1000) - faker.number.int({ min: 0, max: 8 * 60 * 60 * 1000 }));
      // Long-tail distribution: most sessions 5–30 min, a few multi-hour
      const durationMs = faker.helpers.weightedArrayElement([
        { value: faker.number.int({ min: 5, max: 30 }) * 60 * 1000, weight: 60 },
        { value: faker.number.int({ min: 30, max: 120 }) * 60 * 1000, weight: 30 },
        { value: faker.number.int({ min: 120, max: 360 }) * 60 * 1000, weight: 10 },
      ]);
      const endedAt = new Date(startedAt.getTime() + durationMs);
      const inputTokens = faker.number.int({ min: 1000, max: 50000 });
      const outputTokens = faker.number.int({ min: 500, max: 10000 });
      const cacheRead = faker.number.int({ min: 0, max: 20000 });
      const cacheCreation = faker.number.int({ min: 0, max: 5000 });
      const costUsd = (
        inputTokens * PRICE_PER_MTOK.input +
        outputTokens * PRICE_PER_MTOK.output +
        cacheRead * PRICE_PER_MTOK.cache_read +
        cacheCreation * PRICE_PER_MTOK.cache_write
      ) / 1_000_000;
      const toolCalls = faker.number.int({ min: 5, max: 80 });

      const session = await db.session.create({
        data: {
          sessionId: faker.string.uuid(),
          userId: user.id,
          agentType: 'claude_code',
          agentVersion: '1.0.0',
          startedAt,
          endedAt,
          lastEventAt: endedAt,
          status: 'completed',
          repoId: repo.id,
          gitBranch: faker.helpers.arrayElement(['main', 'feat/new-feature', 'fix/bug-123', 'chore/deps']),
          gitCommit: faker.git.commitSha({ length: 40 }),
          claudeCodeVersion: '1.0.0',
          os: faker.helpers.arrayElement(['darwin', 'linux']),
          cwd: `/home/${DEMO_USER_LOGIN}/projects/demo-app`,
          totalInputTokens: BigInt(inputTokens),
          totalOutputTokens: BigInt(outputTokens),
          totalCacheRead: BigInt(cacheRead),
          totalCacheCreation: BigInt(cacheCreation),
          totalCostUsd: costUsd,
          toolCallCount: toolCalls,
          toolErrorCount: faker.number.int({ min: 0, max: Math.floor(toolCalls * 0.1) }),
          permissionPromptCount: faker.number.int({ min: 0, max: 5 }),
          permissionDenyCount: faker.number.int({ min: 0, max: 2 }),
          userMessageCount: faker.number.int({ min: 1, max: 20 }),
          primaryModel: 'claude-sonnet-4-6',
          sonnetTurns: faker.number.int({ min: 5, max: 40 }),
        },
      });

      sessions.push(session.sessionId);

      // Insert 5–10 events per session into the hypertable via raw SQL
      const eventCount = faker.number.int({ min: 5, max: 10 });
      for (let e = 0; e < eventCount; e++) {
        const ts = new Date(startedAt.getTime() + e * Math.floor(durationMs / eventCount));
        const eventType = faker.helpers.arrayElement(['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'SessionStart']);
        await db.$executeRaw`
          INSERT INTO events (
            event_id, session_id, user_id, ts, agent_type, event_type,
            model, input_tokens, output_tokens, cost_usd, mode
          ) VALUES (
            gen_random_uuid(), ${session.sessionId}::uuid, ${user.id}::uuid, ${ts},
            'claude_code', ${eventType},
            'claude-sonnet-4-6',
            ${faker.number.int({ min: 100, max: 2000 })},
            ${faker.number.int({ min: 50, max: 500 })},
            ${faker.number.float({ min: 0.001, max: 0.05, fractionDigits: 6 })},
            'normal'
          )
          ON CONFLICT (event_id) DO NOTHING
        `;
      }
    }
  }

  // Pull Requests — 5 total, 3 merged
  const prData = [
    { number: 101, state: 'merged' as const, title: 'feat: add user dashboard', merged: true },
    { number: 102, state: 'merged' as const, title: 'fix: token expiry check', merged: true },
    { number: 103, state: 'merged' as const, title: 'chore: update deps', merged: true },
    { number: 104, state: 'open' as const, title: 'feat: team view', merged: false },
    { number: 105, state: 'closed' as const, title: 'refactor: cleanup', merged: false },
  ];

  for (const pr of prData) {
    const openedAt = new Date(now - faker.number.int({ min: 5, max: 20 }) * 24 * 60 * 60 * 1000);
    const mergedAt = pr.merged ? new Date(openedAt.getTime() + faker.number.int({ min: 1, max: 3 }) * 24 * 60 * 60 * 1000) : null;
    const closedAt = pr.state !== 'open' ? (mergedAt ?? new Date(openedAt.getTime() + 24 * 60 * 60 * 1000)) : null;

    await db.pullRequest.create({
      data: {
        repoId: repo.id,
        prNumber: pr.number,
        githubId: BigInt(10000000 + pr.number),
        title: pr.title,
        authorUserId: user.id,
        authorGithubLogin: DEMO_USER_LOGIN,
        state: pr.state === 'merged' ? 'merged' : pr.state === 'closed' ? 'closed' : 'open',
        baseBranch: 'main',
        headBranch: `feat/pr-${pr.number}`,
        openedAt,
        closedAt,
        mergedAt,
        linesAdded: faker.number.int({ min: 10, max: 500 }),
        linesRemoved: faker.number.int({ min: 0, max: 200 }),
        filesChanged: faker.number.int({ min: 1, max: 20 }),
        reviewCount: faker.number.int({ min: 1, max: 4 }),
        reviewerLogins: ['reviewer-a', 'reviewer-b'],
        labels: [],
      },
    });

    // Link 2 sessions to each PR
    const linkedSessions = faker.helpers.arrayElements(sessions, 2);
    for (const sessionId of linkedSessions) {
      await db.sessionPRLink.upsert({
        where: { sessionId_repoId_prNumber: { sessionId, repoId: repo.id, prNumber: pr.number } },
        create: { sessionId, repoId: repo.id, prNumber: pr.number, linkSource: 'session_start' },
        update: {},
      });
    }

    // PRRollup for merged PRs
    if (pr.merged) {
      await db.pRRollup.create({
        data: {
          repoId: repo.id,
          prNumber: pr.number,
          contributingUserIds: [user.id],
          contributingSessionIds: linkedSessions,
          firstSessionAt: openedAt,
          lastSessionAt: mergedAt!,
          totalActiveSeconds: faker.number.int({ min: 600, max: 7200 }),
          totalCostUsd: faker.number.float({ min: 0.01, max: 2.0, fractionDigits: 6 }),
          totalInputTokens: BigInt(faker.number.int({ min: 5000, max: 50000 })),
          totalOutputTokens: BigInt(faker.number.int({ min: 1000, max: 10000 })),
          totalToolCalls: faker.number.int({ min: 20, max: 200 }),
          totalToolErrors: faker.number.int({ min: 0, max: 10 }),
          totalPermissionDenies: faker.number.int({ min: 0, max: 5 }),
          costPerLoc: faker.number.float({ min: 0.001, max: 0.05, fractionDigits: 6 }),
        },
      });
    }
  }

  console.log(`Seed complete. Created: 1 team, 1 user, 1 repo, ${sessions.length} sessions, 5 PRs.`);
  await db.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
