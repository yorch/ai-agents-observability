import { promisify } from 'node:util';
import { zstdCompress } from 'node:zlib';
import { hashPassword } from '@ai-agents-observability/auth';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { faker } from '@faker-js/faker';
import { createClient } from './index';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required');
}
const db = createClient(DATABASE_URL);

const isExtensive = process.argv.includes('--extensive');

// ── S3 / transcript upload (optional — seed works without it) ─────────────────

const zstdCompressAsync = promisify(zstdCompress);

const S3_BUCKET = process.env.S3_BUCKET;
const s3 =
  process.env.S3_ENDPOINT &&
  S3_BUCKET &&
  process.env.S3_ACCESS_KEY_ID &&
  process.env.S3_SECRET_ACCESS_KEY
    ? new S3Client({
        credentials: {
          accessKeyId: process.env.S3_ACCESS_KEY_ID,
          secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
        },
        endpoint: process.env.S3_ENDPOINT,
        forcePathStyle: true,
        region: process.env.S3_REGION ?? 'us-east-1',
      })
    : null;

function s3KeyForSession(userId: string, sessionId: string, startedAt: Date): string {
  const yyyy = startedAt.getFullYear();
  const mm = String(startedAt.getMonth() + 1).padStart(2, '0');
  const dd = String(startedAt.getDate()).padStart(2, '0');
  return `transcripts/${yyyy}/${mm}/${dd}/${userId}/${sessionId}.jsonl.zst`;
}

// ── Shared helpers ────────────────────────────────────────────────────────────

const PRICE_PER_MTOK = { cache_read: 0.3, cache_write: 3.75, input: 3.0, output: 15.0 };

function calcCost(input: number, output: number, cacheRead: number, cacheWrite: number) {
  return (
    (input * PRICE_PER_MTOK.input +
      output * PRICE_PER_MTOK.output +
      cacheRead * PRICE_PER_MTOK.cache_read +
      cacheWrite * PRICE_PER_MTOK.cache_write) /
    1_000_000
  );
}

function weightedDurationMs() {
  return faker.helpers.weightedArrayElement([
    { value: faker.number.int({ max: 30, min: 5 }) * 60_000, weight: 60 },
    { value: faker.number.int({ max: 120, min: 30 }) * 60_000, weight: 30 },
    { value: faker.number.int({ max: 360, min: 120 }) * 60_000, weight: 10 },
  ]);
}

const TOOL_NAMES = [
  { value: 'Bash', weight: 35 },
  { value: 'Read', weight: 25 },
  { value: 'Edit', weight: 20 },
  { value: 'Grep', weight: 10 },
  { value: 'Glob', weight: 5 },
  { value: 'Write', weight: 3 },
  { value: 'Agent', weight: 2 },
];

const SKILL_NAMES = [
  { value: { path: '.claude/commands/code-review.md', skillName: 'code-review' }, weight: 30 },
  { value: { path: '.claude/commands/commit.md', skillName: 'commit' }, weight: 25 },
  {
    value: { path: '.claude/commands/systematic-debugging.md', skillName: 'systematic-debugging' },
    weight: 15,
  },
  { value: { path: '.claude/commands/brainstorming.md', skillName: 'brainstorming' }, weight: 10 },
  { value: { path: null as string | null, skillName: 'doc-update' }, weight: 10 },
  { value: { path: null as string | null, skillName: 'refactor' }, weight: 5 },
  { value: { path: null as string | null, skillName: 'ultrareview' }, weight: 5 },
];

const MODELS = [
  { value: 'claude-sonnet-4-6', weight: 60 },
  { value: 'claude-opus-4-8', weight: 25 },
  { value: 'claude-haiku-4-5-20251001', weight: 15 },
];

const CC_VERSIONS = ['1.0.0', '1.1.0', '1.1.2', '1.2.0', '1.2.1', '1.3.0'];

const SESSION_STATUSES = [
  { value: 'COMPLETED' as const, weight: 82 },
  { value: 'CRASHED' as const, weight: 6 },
  { value: 'TIMED_OUT' as const, weight: 6 },
  { value: 'ABANDONED' as const, weight: 6 },
];

// ── Shared credential constants ───────────────────────────────────────────────

const SEED_PW_EMAIL = 'local@example.com';
const SEED_PW_PASSWORD = 'demo1234';
const SEED_ADMIN_EMAIL = 'admin@example.com';
const SEED_ADMIN_PASSWORD = 'admin1234';

// ── Transcript conversation templates ─────────────────────────────────────────

type Msg = { role: 'user' | 'assistant'; text: string };
const TRANSCRIPT_TEMPLATES: { topic: string; messages: Msg[] }[] = [
  {
    messages: [
      {
        role: 'user',
        text: 'Add pagination to the /api/users endpoint. Support `page` and `limit` query params with Zod validation (limit 1–100).',
      },
      {
        role: 'assistant',
        text: "I'll check the current handler first, then add pagination and validation.",
      },
      { role: 'user', text: 'Also return a `totalCount` in the response body.' },
      {
        role: 'assistant',
        text: 'Done — response is now `{ data, totalCount, page, limit }`. Used `COUNT(*) OVER()` to avoid a second query. Zod enforces `.int().min(1).max(100)` on limit.',
      },
      { role: 'user', text: 'Add tests for the invalid cases.' },
      {
        role: 'assistant',
        text: 'Added three tests in `tests/api/users.test.ts`: limit=0 → 400, limit=101 → 400, page=-1 → 400. All green.',
      },
    ],
    topic: 'implement-api-pagination',
  },
  {
    messages: [
      {
        role: 'user',
        text: 'Login returns 401 with correct credentials since the token expiry change yesterday.',
      },
      { role: 'assistant', text: 'Checking the auth middleware and the recent diff.' },
      { role: 'user', text: 'The `expiresIn` was changed from seconds to milliseconds.' },
      {
        role: 'assistant',
        text: '`expiresIn` in jsonwebtoken is seconds-only. Reverting `3600000` → `3600` for access tokens. Bumped refresh to `2592000` (30d) while I was in there.',
      },
    ],
    topic: 'fix-auth-token-expiry',
  },
  {
    messages: [
      {
        role: 'user',
        text: 'Write unit tests for `redactSecrets` in packages/redaction. Cover AWS keys, GitHub tokens, and bearer patterns.',
      },
      {
        role: 'assistant',
        text: 'Reading the implementation first to understand all handled patterns.',
      },
      { role: 'user', text: 'Also add a snapshot test for the [REDACTED] replacement format.' },
      {
        role: 'assistant',
        text: 'Written 12 tests: AWS access/secret, GitHub ghp_/ghs_, Bearer headers, npm tokens, sk- patterns, plus edge cases (empty string, no secrets, multiple per line). Snapshot added — run `bun test -u` to update if the format changes intentionally.',
      },
    ],
    topic: 'redaction-tests',
  },
  {
    messages: [
      {
        role: 'user',
        text: 'Split `SessionService` — it is too large. Separate lifecycle from querying.',
      },
      {
        role: 'assistant',
        text: 'Auditing the class for natural seams — lifecycle (create/update/close) and query (find/list/aggregate) are the clear boundaries.',
      },
      { role: 'user', text: 'Also extract cost calculation helpers to costs.ts.' },
      {
        role: 'assistant',
        text: 'Done: `SessionLifecycleService`, `SessionQueryService`, `src/utils/costs.ts`. Original class re-exports both — zero callers broken.',
      },
    ],
    topic: 'refactor-session-service',
  },
  {
    messages: [
      { role: 'user', text: '/api/dashboard/summary takes 3–4 seconds with 50k sessions.' },
      { role: 'assistant', text: 'Checking the query plan for the sessions fetch.' },
      { role: 'user', text: 'Probably a full table scan — no index on userId + startedAt.' },
      {
        role: 'assistant',
        text: 'Confirmed. Added composite index on `(user_id, started_at DESC)`. Response drops to ~120ms. Also manually refreshed the `daily_cost_by_user` continuous aggregate.',
      },
    ],
    topic: 'debug-dashboard-perf',
  },
  {
    messages: [
      { role: 'user', text: 'Bun 1.2.0 released. Upgrade and check for breakage.' },
      {
        role: 'assistant',
        text: 'Updating Dockerfile and .tool-versions, running bun install to refresh lockfile.',
      },
      { role: 'user', text: 'Any workspace package bumps needed?' },
      {
        role: 'assistant',
        text: '`@faker-js/faker` and `vitest` had minor updates — bumped in root catalog. All 147 tests pass. Test time: 12.4s → 8.1s.',
      },
    ],
    topic: 'bun-upgrade',
  },
  {
    messages: [
      {
        role: 'user',
        text: 'Add a `tags TEXT[]` column to sessions for user-defined labels. Prisma-managed so we get the typed client.',
      },
      {
        role: 'assistant',
        text: 'Adding `tags String[] @default([])` to the Session model, generating a migration.',
      },
      { role: 'user', text: 'Should we index it?' },
      {
        role: 'assistant',
        text: 'Added a GIN index: `CREATE INDEX idx_sessions_tags ON sessions USING GIN (tags)`. Enables efficient `?` (contains element) and `@>` (contains all) queries.',
      },
    ],
    topic: 'session-tags-migration',
  },
  {
    messages: [
      {
        role: 'user',
        text: 'Review the GitHub webhook handler for security issues, especially HMAC signature validation.',
      },
      {
        role: 'assistant',
        text: 'Reading the diff, focusing on validation ordering and comparison safety.',
      },
      { role: 'user', text: 'Found anything?' },
      {
        role: 'assistant',
        text: 'Two issues: (1) `===` instead of `crypto.timingSafeEqual` — timing attack risk. (2) JSON parsed before signature check — a parse error skips validation entirely. Fixed both. Also returning 204 on intentionally ignored event types.',
      },
    ],
    topic: 'webhook-security-review',
  },
  {
    messages: [
      {
        role: 'user',
        text: 'GitHub Actions: lint → typecheck → build → test on every PR, Bun with lockfile cache.',
      },
      {
        role: 'assistant',
        text: 'Creating `.github/workflows/ci.yml` with `oven-sh/setup-bun@v2`, cache keyed on lockfile hash, four sequential steps for clear failure attribution.',
      },
      { role: 'user', text: 'Add a coverage comment posted to the PR.' },
      {
        role: 'assistant',
        text: 'Added `vitest run --coverage` step + `marocchino/sticky-pull-request-comment`. Needs `permissions: pull-requests: write` in the job.',
      },
    ],
    topic: 'ci-setup',
  },
  {
    messages: [
      {
        role: 'user',
        text: 'Build team cost breakdown chart — daily cost per dev, last 30 days, from the daily_cost_by_user continuous aggregate.',
      },
      {
        role: 'assistant',
        text: 'Using Recharts AreaChart with stacked areas — shows per-dev and total simultaneously.',
      },
      { role: 'user', text: 'Add a DateRangePicker to change the window.' },
      {
        role: 'assistant',
        text: 'Added `DateRangePicker` on react-day-picker. Range updates the query param → CA re-fetch. Default 30 days, max 365.',
      },
    ],
    topic: 'team-cost-chart',
  },
  {
    messages: [
      {
        role: 'user',
        text: 'Add rate limiting to ingest: 100 req/min per hook token, 429 with Retry-After header on breach.',
      },
      {
        role: 'assistant',
        text: 'Implemented in-memory sliding window keyed by token hash. For multi-instance deployments, swap the Map for a Redis counter.',
      },
      { role: 'user', text: 'Test that the 101st request in a minute is rejected.' },
      {
        role: 'assistant',
        text: 'Test added with fake timers: requests 1–100 → 200, request 101 → 429 with `Retry-After: 60`. Green.',
      },
    ],
    topic: 'rate-limiting',
  },
  {
    messages: [
      {
        role: 'user',
        text: 'Redaction is missing the new OpenAI `sk-proj-` key format (48 chars after prefix).',
      },
      {
        role: 'assistant',
        text: 'Adding `/sk-proj-[A-Za-z0-9_-]{48}/g` and `sk-svcacct-` patterns to the redactor.',
      },
      {
        role: 'user',
        text: 'We should retroactively re-process transcripts from the last 7 days.',
      },
      {
        role: 'assistant',
        text: 'Created `scripts/redact-backfill.ts` — fetches transcript S3 keys for last 7 days, re-runs redaction, overwrites if changed. Run with DATABASE_URL + S3 env vars.',
      },
    ],
    topic: 'openai-key-redaction',
  },
  {
    messages: [
      {
        role: 'user',
        text: 'Wire up the GitHub MCP server so Claude Code can create issues and PRs directly.',
      },
      {
        role: 'assistant',
        text: 'Adding the MCP server config to `.claude/settings.json` and documenting the required scopes.',
      },
      { role: 'user', text: 'The token needs `repo` and `issues:write` scopes.' },
      {
        role: 'assistant',
        text: 'Config added. The server exposes `create_issue`, `list_issues`, `create_pull_request`, and `search_code`. Tested with a dummy issue — working. Store the PAT in `GITHUB_TOKEN` env var.',
      },
    ],
    topic: 'mcp-server-integration',
  },
  {
    messages: [
      {
        role: 'user',
        text: 'Set up a data retention policy — drop events older than 90 days automatically.',
      },
      {
        role: 'assistant',
        text: 'Adding a TimescaleDB retention policy on the `events` hypertable.',
      },
      { role: 'user', text: 'Also compress chunks older than 7 days to save space.' },
      {
        role: 'assistant',
        text: "Done: `SELECT add_retention_policy('events', INTERVAL '90 days')` and compression policy at 7 days. Added to `packages/db/sql/migrations/0003_retention.sql`.",
      },
    ],
    topic: 'timescale-retention',
  },
  {
    messages: [
      {
        role: 'user',
        text: 'Getting `PrismaClientKnownRequestError P2002` on session create — unique constraint violation.',
      },
      {
        role: 'assistant',
        text: 'P2002 on session create means `session_id` collision. Let me check how the session ID is generated.',
      },
      { role: 'user', text: 'The hook is reusing the same UUID across restarts.' },
      {
        role: 'assistant',
        text: 'The hook should generate a fresh UUID on each `SessionStart` event, not load it from a config file. Fixed the hook to call `crypto.randomUUID()` at boot. Added an upsert path in ingest as a safety net for resume flows.',
      },
    ],
    topic: 'prisma-client-error',
  },
];

// ── Event + transcript insertion helpers ──────────────────────────────────────

async function insertEvents(
  sessionId: string,
  userId: string,
  startedAt: Date,
  durationMs: number,
  toolCallCount: number,
  model: string,
) {
  const eventCount = faker.number.int({ max: Math.min(14, toolCallCount + 3), min: 3 });

  for (let e = 0; e < eventCount; e++) {
    const ts = new Date(
      startedAt.getTime() + Math.floor((e / Math.max(1, eventCount - 1)) * durationMs),
    );
    const eventId = crypto.randomUUID();

    if (e === 0) {
      await db.$executeRaw`
        INSERT INTO events (event_id, session_id, user_id, ts, agent_type, event_type, model, mode)
        VALUES (${eventId}::uuid, ${sessionId}::uuid, ${userId}::uuid, ${ts},
                'CLAUDE_CODE', 'SessionStart', ${model}, 'normal')
        ON CONFLICT (session_id, event_id, ts) DO NOTHING
      `;
    } else if (e === eventCount - 1) {
      await db.$executeRaw`
        INSERT INTO events (event_id, session_id, user_id, ts, agent_type, event_type, model, mode)
        VALUES (${eventId}::uuid, ${sessionId}::uuid, ${userId}::uuid, ${ts},
                'CLAUDE_CODE', 'Stop', ${model}, 'normal')
        ON CONFLICT (session_id, event_id, ts) DO NOTHING
      `;
    } else if (e % 4 === 1) {
      const inputToks = faker.number.int({ max: 2000, min: 50 });
      const turnNum = Math.ceil(e / 4);
      await db.$executeRaw`
        INSERT INTO events (event_id, session_id, user_id, ts, agent_type, event_type, model, input_tokens, turn_number, mode)
        VALUES (${eventId}::uuid, ${sessionId}::uuid, ${userId}::uuid, ${ts},
                'CLAUDE_CODE', 'UserPromptSubmit', ${model}, ${inputToks}, ${turnNum}, 'normal')
        ON CONFLICT (session_id, event_id, ts) DO NOTHING
      `;
    } else {
      const toolName = faker.helpers.weightedArrayElement(TOOL_NAMES);
      const wasDenied = faker.datatype.boolean({ probability: 0.04 });
      const toolDurMs = faker.number.int({
        max: toolName === 'Bash' ? 8000 : 300,
        min: toolName === 'Bash' ? 30 : 5,
      });
      const outputToks = faker.number.int({ max: 600, min: 10 });
      const costVal = faker.number.float({ fractionDigits: 6, max: 0.02, min: 0.0001 });
      const turnNum = Math.ceil(e / 4);
      const useSkill = faker.datatype.boolean({ probability: 0.12 });
      const useMcp = !useSkill && faker.datatype.boolean({ probability: 0.06 });

      if (useSkill) {
        const { skillName, path: skillPath } = faker.helpers.weightedArrayElement(SKILL_NAMES);
        await db.$executeRaw`
          INSERT INTO events (event_id, session_id, user_id, ts, agent_type, event_type,
                              tool_name, skill_name, slash_command, skill_path,
                              tool_duration_ms, output_tokens, cost_usd, turn_number, model, mode)
          VALUES (${eventId}::uuid, ${sessionId}::uuid, ${userId}::uuid, ${ts},
                  'CLAUDE_CODE', 'PostToolUse',
                  'Skill', ${skillName}, ${skillName}, ${skillPath},
                  ${toolDurMs}, ${outputToks}, ${costVal}, ${turnNum}, ${model}, 'normal')
          ON CONFLICT (session_id, event_id, ts) DO NOTHING
        `;
      } else if (useMcp) {
        const mcpServer = faker.helpers.arrayElement(['github', 'filesystem', 'web-search']);
        const mcpTool = faker.helpers.arrayElement([
          'list_files',
          'read_file',
          'search_code',
          'create_issue',
        ]);
        await db.$executeRaw`
          INSERT INTO events (event_id, session_id, user_id, ts, agent_type, event_type,
                              tool_name, tool_duration_ms, tool_was_denied,
                              output_tokens, cost_usd, mcp_server, mcp_tool, turn_number, model, mode)
          VALUES (${eventId}::uuid, ${sessionId}::uuid, ${userId}::uuid, ${ts},
                  'CLAUDE_CODE', 'PostToolUse',
                  ${toolName}, ${toolDurMs}, ${wasDenied},
                  ${outputToks}, ${costVal}, ${mcpServer}, ${mcpTool}, ${turnNum}, ${model}, 'normal')
          ON CONFLICT (session_id, event_id, ts) DO NOTHING
        `;
      } else {
        await db.$executeRaw`
          INSERT INTO events (event_id, session_id, user_id, ts, agent_type, event_type,
                              tool_name, tool_duration_ms, tool_was_denied,
                              output_tokens, cost_usd, turn_number, model, mode)
          VALUES (${eventId}::uuid, ${sessionId}::uuid, ${userId}::uuid, ${ts},
                  'CLAUDE_CODE', 'PostToolUse',
                  ${toolName}, ${toolDurMs}, ${wasDenied},
                  ${outputToks}, ${costVal}, ${turnNum}, ${model}, 'normal')
          ON CONFLICT (session_id, event_id, ts) DO NOTHING
        `;
      }
    }
  }
}

async function insertTranscript(sessionId: string, startedAt: Date, durationMs: number) {
  const template = faker.helpers.arrayElement(TRANSCRIPT_TEMPLATES);
  for (let i = 0; i < template.messages.length; i++) {
    const ts = new Date(
      startedAt.getTime() + Math.floor((i / template.messages.length) * durationMs),
    );
    const msg = template.messages[i];
    if (!msg) {
      continue;
    }
    const { role, text } = msg;
    await db.$executeRaw`
      INSERT INTO transcript_index (session_id, message_idx, role, ts, content_text)
      VALUES (${sessionId}::uuid, ${i}, ${role}, ${ts}, ${text})
      ON CONFLICT (session_id, message_idx) DO NOTHING
    `;
  }
}

async function uploadTranscriptToS3(
  sessionId: string,
  userId: string,
  startedAt: Date,
  durationMs: number,
  model: string,
): Promise<void> {
  if (!s3 || !S3_BUCKET) {
    return;
  }
  const template = faker.helpers.arrayElement(TRANSCRIPT_TEMPLATES);
  const lines: string[] = [];
  for (const [i, { role, text }] of template.messages.entries()) {
    const ts = new Date(
      startedAt.getTime() + Math.floor((i / template.messages.length) * durationMs),
    ).toISOString();
    if (role === 'user') {
      lines.push(JSON.stringify({ message: { content: text }, timestamp: ts, type: 'user' }));
    } else {
      lines.push(
        JSON.stringify({
          message: {
            content: [{ text, type: 'text' }],
            model,
            usage: {
              cache_creation_input_tokens: faker.number.int({ max: 2000, min: 0 }),
              cache_read_input_tokens: faker.number.int({ max: 5000, min: 0 }),
              input_tokens: faker.number.int({ max: 3000, min: 100 }),
              output_tokens: faker.number.int({ max: 800, min: 20 }),
            },
          },
          timestamp: ts,
          type: 'assistant',
        }),
      );
    }
  }
  const ndjson = `${lines.join('\n')}\n`;
  const compressed = await zstdCompressAsync(Buffer.from(ndjson));
  const key = s3KeyForSession(userId, sessionId, startedAt);
  await s3.send(
    new PutObjectCommand({
      Body: compressed,
      Bucket: S3_BUCKET,
      ContentType: 'application/zstd',
      Key: key,
    }),
  );
  await db.session.update({
    data: {
      transcriptBytes: BigInt(compressed.byteLength),
      transcriptS3Key: key,
      transcriptUploadedAt: new Date(),
    },
    where: { sessionId },
  });
}

// ── Basic seed ────────────────────────────────────────────────────────────────

const BASIC_EMAIL = 'demo@example.com';
const BASIC_LOGIN = 'demo-dev';

async function basicSeed() {
  const existing = await db.user.findUnique({ where: { githubLogin: BASIC_LOGIN } });
  if (existing) {
    await db.session.deleteMany({ where: { userId: existing.id } });
  }
  const existingPw = await db.user.findUnique({ where: { email: SEED_PW_EMAIL } });
  if (existingPw) {
    await db.auditLog.deleteMany({ where: { actorUserId: existingPw.id } });
    await db.user.delete({ where: { id: existingPw.id } });
  }
  const existingAdmin = await db.user.findUnique({ where: { email: SEED_ADMIN_EMAIL } });
  if (existingAdmin) {
    await db.auditLog.deleteMany({ where: { actorUserId: existingAdmin.id } });
    await db.user.delete({ where: { id: existingAdmin.id } });
  }
  await db.repo.deleteMany({ where: { githubOwner: 'demo-org' } });
  if (existing) {
    await db.auditLog.deleteMany({ where: { actorUserId: existing.id } });
    await db.user.delete({ where: { id: existing.id } });
  }
  const existingTeam = await db.team.findUnique({ where: { githubSlug: 'demo-org' } });
  if (existingTeam) {
    await db.team.delete({ where: { id: existingTeam.id } });
  }

  const team = await db.team.create({
    data: {
      githubId: BigInt(1234567),
      githubSlug: 'demo-org',
      name: 'Demo Org',
      syncedAt: new Date(),
    },
  });

  const user = await db.user.create({
    data: {
      createdAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
      displayName: 'Demo Dev',
      email: BASIC_EMAIL,
      githubId: BigInt(9876543),
      githubLogin: BASIC_LOGIN,
      lastSeenAt: new Date(),
      primaryTeamId: team.id,
    },
  });
  await db.teamMember.create({ data: { roleInTeam: 'MEMBER', teamId: team.id, userId: user.id } });
  await db.visibilityPolicy.create({
    data: {
      shareMetadataWithOrg: true,
      shareMetadataWithTeam: true,
      shareTranscriptsWithOrg: false,
      shareTranscriptsWithTeam: false,
      userId: user.id,
    },
  });

  const passwordHash = await hashPassword(SEED_PW_PASSWORD);
  const pwUser = await db.user.create({
    data: {
      displayName: 'Local Dev',
      email: SEED_PW_EMAIL,
      lastSeenAt: new Date(),
      passwordHash,
      primaryTeamId: team.id,
      visibilityPolicy: {
        create: {
          shareMetadataWithOrg: true,
          shareMetadataWithTeam: true,
          shareTranscriptsWithOrg: false,
          shareTranscriptsWithTeam: false,
        },
      },
    },
  });
  await db.teamMember.create({ data: { roleInTeam: 'LEAD', teamId: team.id, userId: pwUser.id } });

  const adminHash = await hashPassword(SEED_ADMIN_PASSWORD);
  const adminUser = await db.user.create({
    data: {
      displayName: 'Org Admin',
      email: SEED_ADMIN_EMAIL,
      lastSeenAt: new Date(),
      orgRole: 'ORG_ADMIN',
      passwordHash: adminHash,
      primaryTeamId: team.id,
      visibilityPolicy: {
        create: {
          shareMetadataWithOrg: true,
          shareMetadataWithTeam: true,
          shareTranscriptsWithOrg: false,
          shareTranscriptsWithTeam: false,
        },
      },
    },
  });
  await db.teamMember.create({
    data: { roleInTeam: 'LEAD', teamId: team.id, userId: adminUser.id },
  });

  const repo = await db.repo.create({
    data: {
      defaultBranch: 'main',
      githubId: BigInt(555666777),
      githubName: 'demo-app',
      githubOwner: 'demo-org',
      owningTeamId: team.id,
    },
  });

  // 30 days × 3/day = 90 sessions
  const sessions: string[] = [];
  const now = Date.now();

  for (let day = 29; day >= 0; day--) {
    for (let i = 0; i < 3; i++) {
      const startedAt = new Date(
        now - day * 86_400_000 - faker.number.int({ max: 8 * 3_600_000, min: 0 }),
      );
      const durationMs = weightedDurationMs();
      const endedAt = new Date(startedAt.getTime() + durationMs);
      const inputTokens = faker.number.int({ max: 50000, min: 1000 });
      const outputTokens = faker.number.int({ max: 10000, min: 500 });
      const cacheRead = faker.number.int({ max: 20000, min: 0 });
      const cacheCreation = faker.number.int({ max: 5000, min: 0 });
      const toolCalls = faker.number.int({ max: 80, min: 5 });

      const session = await db.session.create({
        data: {
          agentType: 'CLAUDE_CODE',
          agentVersion: '1.0.0',
          claudeCodeVersion: '1.0.0',
          cwd: `/home/${BASIC_LOGIN}/projects/demo-app`,
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
          status: 'COMPLETED',
          toolCallCount: toolCalls,
          toolErrorCount: faker.number.int({ max: Math.floor(toolCalls * 0.1), min: 0 }),
          totalCacheCreation: BigInt(cacheCreation),
          totalCacheRead: BigInt(cacheRead),
          totalCostUsd: calcCost(inputTokens, outputTokens, cacheRead, cacheCreation),
          totalInputTokens: BigInt(inputTokens),
          totalOutputTokens: BigInt(outputTokens),
          userId: user.id,
          userMessageCount: faker.number.int({ max: 20, min: 1 }),
        },
      });
      sessions.push(session.sessionId);

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
            'CLAUDE_CODE', ${eventType},
            'claude-sonnet-4-6',
            ${faker.number.int({ max: 2000, min: 100 })},
            ${faker.number.int({ max: 500, min: 50 })},
            ${faker.number.float({ fractionDigits: 6, max: 0.05, min: 0.001 })},
            'normal'
          )
          ON CONFLICT (session_id, event_id, ts) DO NOTHING
        `;
      }

      await insertTranscript(session.sessionId, startedAt, durationMs);
      await uploadTranscriptToS3(
        session.sessionId,
        user.id,
        startedAt,
        durationMs,
        'claude-sonnet-4-6',
      );

      const skillCount = faker.number.int({ max: 2, min: 0 });
      for (let sk = 0; sk < skillCount; sk++) {
        const skillTs = new Date(
          startedAt.getTime() + faker.number.int({ max: durationMs, min: 1 }),
        );
        const { skillName, path: skillPath } = faker.helpers.weightedArrayElement(SKILL_NAMES);
        const skillEventId = crypto.randomUUID();
        await db.$executeRaw`
          INSERT INTO events (event_id, session_id, user_id, ts, agent_type, event_type,
                              tool_name, skill_name, slash_command, skill_path,
                              tool_duration_ms, output_tokens, cost_usd, mode)
          VALUES (${skillEventId}::uuid, ${session.sessionId}::uuid, ${user.id}::uuid, ${skillTs},
                  'CLAUDE_CODE', 'PostToolUse',
                  'Skill', ${skillName}, ${skillName}, ${skillPath},
                  ${faker.number.int({ max: 5000, min: 100 })},
                  ${faker.number.int({ max: 300, min: 10 })},
                  ${faker.number.float({ fractionDigits: 6, max: 0.02, min: 0.001 })},
                  'normal')
          ON CONFLICT (session_id, event_id, ts) DO NOTHING
        `;
      }
    }
  }

  // Admin user: 20 days × 1-2 sessions/day
  for (let day = 19; day >= 0; day--) {
    const dayCount = faker.number.int({ max: 2, min: 1 });
    for (let i = 0; i < dayCount; i++) {
      const startedAt = new Date(
        now - day * 86_400_000 - faker.number.int({ max: 6 * 3_600_000, min: 0 }),
      );
      const durationMs = weightedDurationMs();
      const endedAt = new Date(startedAt.getTime() + durationMs);
      const inputTokens = faker.number.int({ max: 60000, min: 1000 });
      const outputTokens = faker.number.int({ max: 12000, min: 500 });
      const cacheRead = faker.number.int({ max: 25000, min: 0 });
      const cacheCreation = faker.number.int({ max: 6000, min: 0 });
      const toolCalls = faker.number.int({ max: 100, min: 5 });
      const model = faker.helpers.weightedArrayElement(MODELS);
      const status = faker.helpers.weightedArrayElement(SESSION_STATUSES);

      const adminSession = await db.session.create({
        data: {
          agentType: 'CLAUDE_CODE',
          agentVersion: '1.1.2',
          claudeCodeVersion: '1.1.2',
          cwd: `/home/admin/projects/demo-app`,
          endedAt,
          gitBranch: faker.helpers.arrayElement([
            'main',
            'feat/org-dashboard',
            'fix/auth',
            'chore/infra',
          ]),
          gitCommit: faker.git.commitSha({ length: 40 }),
          lastEventAt: endedAt,
          os: 'darwin',
          permissionDenyCount: faker.number.int({ max: 3, min: 0 }),
          permissionPromptCount: faker.number.int({ max: 8, min: 0 }),
          primaryModel: model,
          repoId: repo.id,
          sessionId: faker.string.uuid(),
          startedAt,
          status,
          toolCallCount: toolCalls,
          toolErrorCount: faker.number.int({ max: Math.floor(toolCalls * 0.1), min: 0 }),
          totalCacheCreation: BigInt(cacheCreation),
          totalCacheRead: BigInt(cacheRead),
          totalCostUsd: calcCost(inputTokens, outputTokens, cacheRead, cacheCreation),
          totalInputTokens: BigInt(inputTokens),
          totalOutputTokens: BigInt(outputTokens),
          userId: adminUser.id,
          userMessageCount: faker.number.int({ max: 25, min: 1 }),
        },
      });

      await insertEvents(
        adminSession.sessionId,
        adminUser.id,
        startedAt,
        durationMs,
        toolCalls,
        model,
      );

      if (status === 'COMPLETED' && faker.datatype.boolean({ probability: 0.6 })) {
        await insertTranscript(adminSession.sessionId, startedAt, durationMs);
        await uploadTranscriptToS3(
          adminSession.sessionId,
          adminUser.id,
          startedAt,
          durationMs,
          model,
        );
      }
    }
  }

  const prData = [
    { merged: true, number: 101, state: 'merged' as const, title: 'feat: add user dashboard' },
    { merged: true, number: 102, state: 'merged' as const, title: 'fix: token expiry check' },
    { merged: true, number: 103, state: 'merged' as const, title: 'chore: update deps' },
    { merged: false, number: 104, state: 'open' as const, title: 'feat: team view' },
    { merged: false, number: 105, state: 'closed' as const, title: 'refactor: cleanup' },
  ];

  for (const pr of prData) {
    const openedAt = new Date(now - faker.number.int({ max: 20, min: 5 }) * 86_400_000);
    const mergedAt = pr.merged
      ? new Date(openedAt.getTime() + faker.number.int({ max: 3, min: 1 }) * 86_400_000)
      : null;
    const closedAt =
      pr.state !== 'open' ? (mergedAt ?? new Date(openedAt.getTime() + 86_400_000)) : null;

    await db.pullRequest.create({
      data: {
        authorGithubLogin: BASIC_LOGIN,
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
        state: pr.state === 'merged' ? 'MERGED' : pr.state === 'closed' ? 'CLOSED' : 'OPEN',
        title: pr.title,
      },
    });

    const linkedSessions = faker.helpers.arrayElements(sessions, 2);
    for (const sessionId of linkedSessions) {
      await db.sessionPRLink.upsert({
        create: { linkSource: 'SESSION_START', prNumber: pr.number, repoId: repo.id, sessionId },
        update: {},
        where: { sessionId_repoId_prNumber: { prNumber: pr.number, repoId: repo.id, sessionId } },
      });
    }

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
    `Seed complete. Created: 1 team, 3 users, 1 repo, ${sessions.length} sessions, 5 PRs.`,
  );
  console.log(`  GitHub user  : ${BASIC_EMAIL} (login via GitHub OAuth)`);
  console.log(`  Password user: ${SEED_PW_EMAIL} / ${SEED_PW_PASSWORD}`);
  console.log(`  Admin user   : ${SEED_ADMIN_EMAIL} / ${SEED_ADMIN_PASSWORD} (ORG_ADMIN)`);
}

// ── Extensive seed ────────────────────────────────────────────────────────────

const EXT_ORG = 'demo-org';

const EXT_DEVS = [
  {
    avgPerDay: 3.0,
    daysAgo: 180,
    email: 'alice@example.com',
    githubId: 10_000_001,
    login: 'alice-coder',
    name: 'Alice Chen',
    password: 'alice1234',
    role: 'LEAD' as const,
  },
  {
    avgPerDay: 2.0,
    daysAgo: 180,
    email: 'bob@example.com',
    githubId: 10_000_002,
    login: 'bob-engineer',
    name: 'Bob Torres',
    password: 'bob1234',
    role: 'MEMBER' as const,
  },
  {
    avgPerDay: 1.2,
    daysAgo: 180,
    email: 'carol@example.com',
    githubId: 10_000_003,
    login: 'carol-dev',
    name: 'Carol Mbeki',
    password: 'carol1234',
    role: 'MEMBER' as const,
  },
  {
    avgPerDay: 0.6,
    daysAgo: 180,
    email: 'dave@example.com',
    githubId: 10_000_004,
    login: 'dave-lead',
    name: 'Dave Park',
    orgRole: 'ORG_ADMIN' as const,
    password: 'dave1234',
    role: 'LEAD' as const,
  },
  {
    avgPerDay: 2.0,
    daysAgo: 45,
    email: 'eva@example.com',
    githubId: 10_000_005,
    login: 'eva-new',
    name: 'Eva Okonkwo',
    password: 'eva1234',
    role: 'MEMBER' as const,
  },
];

const EXT_REPOS = [
  {
    branches: [
      'main',
      'feat/dark-mode',
      'fix/login-redirect',
      'feat/dashboard-v2',
      'chore/upgrade-react',
      'feat/notifications',
    ],
    cwdSuffix: 'projects/demo-app',
    githubId: 20_000_001n,
    name: 'demo-app',
  },
  {
    branches: [
      'main',
      'feat/rate-limiting',
      'fix/memory-leak',
      'feat/graphql',
      'fix/auth-token',
      'chore/update-prisma',
    ],
    cwdSuffix: 'projects/api-service',
    githubId: 20_000_002n,
    name: 'api-service',
  },
  {
    branches: [
      'main',
      'feat/k8s-config',
      'fix/terraform-state',
      'chore/update-helm',
      'feat/monitoring',
    ],
    cwdSuffix: 'code/infra-scripts',
    githubId: 20_000_003n,
    name: 'infra-scripts',
  },
];

type PRDef = {
  repoName: string;
  number: number;
  title: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  labels: string[];
  headBranch: string;
  authorLogin: string;
};

const EXT_PRS: PRDef[] = [
  {
    authorLogin: 'alice-coder',
    headBranch: 'feat/dark-mode',
    labels: ['feature', 'frontend'],
    number: 201,
    repoName: 'demo-app',
    state: 'MERGED',
    title: 'feat: dark mode toggle',
  },
  {
    authorLogin: 'bob-engineer',
    headBranch: 'fix/login-redirect',
    labels: ['bug', 'auth'],
    number: 202,
    repoName: 'demo-app',
    state: 'MERGED',
    title: 'fix: login redirect after OAuth',
  },
  {
    authorLogin: 'alice-coder',
    headBranch: 'feat/dashboard-v2',
    labels: ['feature', 'design'],
    number: 203,
    repoName: 'demo-app',
    state: 'OPEN',
    title: 'feat: dashboard v2 redesign',
  },
  {
    authorLogin: 'carol-dev',
    headBranch: 'chore/upgrade-react',
    labels: ['chore', 'deps'],
    number: 204,
    repoName: 'demo-app',
    state: 'MERGED',
    title: 'chore: upgrade React to 19.2',
  },
  {
    authorLogin: 'eva-new',
    headBranch: 'feat/notifications',
    labels: ['feature'],
    number: 205,
    repoName: 'demo-app',
    state: 'OPEN',
    title: 'feat: real-time notifications via SSE',
  },
  {
    authorLogin: 'bob-engineer',
    headBranch: 'fix/cost-chart',
    labels: ['bug'],
    number: 206,
    repoName: 'demo-app',
    state: 'MERGED',
    title: 'fix: cost chart stale on date range change',
  },
  {
    authorLogin: 'alice-coder',
    headBranch: 'feat/team-cost-chart',
    labels: ['feature', 'dashboard'],
    number: 207,
    repoName: 'demo-app',
    state: 'MERGED',
    title: 'feat: team cost breakdown chart',
  },
  {
    authorLogin: 'eva-new',
    headBranch: 'refactor/date-picker',
    labels: ['refactor'],
    number: 208,
    repoName: 'demo-app',
    state: 'CLOSED',
    title: 'refactor: extract DateRangePicker component',
  },
  {
    authorLogin: 'alice-coder',
    headBranch: 'feat/rate-limiting',
    labels: ['feature', 'security'],
    number: 301,
    repoName: 'api-service',
    state: 'MERGED',
    title: 'feat: rate limiting on ingest endpoint',
  },
  {
    authorLogin: 'dave-lead',
    headBranch: 'fix/memory-leak',
    labels: ['bug', 'performance'],
    number: 302,
    repoName: 'api-service',
    state: 'MERGED',
    title: 'fix: memory leak in event flusher',
  },
  {
    authorLogin: 'bob-engineer',
    headBranch: 'feat/graphql',
    labels: ['feature', 'graphql'],
    number: 303,
    repoName: 'api-service',
    state: 'OPEN',
    title: 'feat: GraphQL endpoint for session queries',
  },
  {
    authorLogin: 'alice-coder',
    headBranch: 'fix/webhook-hmac',
    labels: ['bug', 'security'],
    number: 304,
    repoName: 'api-service',
    state: 'MERGED',
    title: 'fix: HMAC timing attack in webhook handler',
  },
  {
    authorLogin: 'carol-dev',
    headBranch: 'feat/paginate-users',
    labels: ['feature', 'api'],
    number: 305,
    repoName: 'api-service',
    state: 'MERGED',
    title: 'feat: pagination for /api/users',
  },
  {
    authorLogin: 'carol-dev',
    headBranch: 'chore/update-prisma',
    labels: ['chore', 'deps'],
    number: 306,
    repoName: 'api-service',
    state: 'MERGED',
    title: 'chore: bump @prisma/client to 7.1',
  },
  {
    authorLogin: 'bob-engineer',
    headBranch: 'fix/webhook-sig',
    labels: ['bug', 'security'],
    number: 307,
    repoName: 'api-service',
    state: 'MERGED',
    title: 'fix: webhook signature skipped on parse error',
  },
  {
    authorLogin: 'eva-new',
    headBranch: 'feat/session-tags',
    labels: ['feature'],
    number: 308,
    repoName: 'api-service',
    state: 'OPEN',
    title: 'feat: session tags support',
  },
  {
    authorLogin: 'dave-lead',
    headBranch: 'feat/k8s-config',
    labels: ['infra', 'k8s'],
    number: 401,
    repoName: 'infra-scripts',
    state: 'MERGED',
    title: 'feat: Kubernetes deployment manifests',
  },
  {
    authorLogin: 'dave-lead',
    headBranch: 'fix/terraform-state',
    labels: ['bug', 'terraform'],
    number: 402,
    repoName: 'infra-scripts',
    state: 'MERGED',
    title: 'fix: Terraform state lock not released',
  },
  {
    authorLogin: 'carol-dev',
    headBranch: 'chore/update-helm',
    labels: ['chore', 'helm'],
    number: 403,
    repoName: 'infra-scripts',
    state: 'MERGED',
    title: 'chore: upgrade Helm charts to v4',
  },
  {
    authorLogin: 'alice-coder',
    headBranch: 'feat/monitoring',
    labels: ['feature', 'monitoring'],
    number: 404,
    repoName: 'infra-scripts',
    state: 'OPEN',
    title: 'feat: Grafana monitoring dashboards',
  },
  {
    authorLogin: 'bob-engineer',
    headBranch: 'fix/ci-cache',
    labels: ['bug', 'ci'],
    number: 405,
    repoName: 'infra-scripts',
    state: 'MERGED',
    title: 'fix: CI cache broken after Bun upgrade',
  },
];

async function extensiveSeed() {
  // ── Cleanup ───────────────────────────────────────────────────────────────────
  const allEmails = [...EXT_DEVS.map((d) => d.email), SEED_PW_EMAIL, SEED_ADMIN_EMAIL];
  const allLogins = EXT_DEVS.map((d) => d.login);

  const existingUsers = await db.user.findMany({
    where: { OR: [{ email: { in: allEmails } }, { githubLogin: { in: allLogins } }] },
  });
  const existingIds = existingUsers.map((u: { id: string }) => u.id);

  if (existingIds.length > 0) {
    for (const uid of existingIds) {
      await db.$executeRaw`DELETE FROM events WHERE user_id = ${uid}::uuid`;
    }
    await db.session.deleteMany({ where: { userId: { in: existingIds } } });
    await db.auditLog.deleteMany({ where: { actorUserId: { in: existingIds } } });
  }
  await db.repo.deleteMany({ where: { githubOwner: EXT_ORG } });
  if (existingIds.length > 0) {
    await db.user.deleteMany({ where: { id: { in: existingIds } } });
  }
  await db.team.deleteMany({ where: { githubSlug: EXT_ORG } });

  // ── Team ──────────────────────────────────────────────────────────────────────
  const team = await db.team.create({
    data: {
      githubId: BigInt(2_000_000),
      githubSlug: EXT_ORG,
      name: 'Demo Org',
      syncedAt: new Date(),
    },
  });

  // ── Users ─────────────────────────────────────────────────────────────────────
  const devUserMap = new Map<string, string>(); // login → userId

  for (const dev of EXT_DEVS) {
    const createdAt = new Date(Date.now() - dev.daysAgo * 86_400_000);
    const passwordHash = await hashPassword(dev.password);
    const u = await db.user.create({
      data: {
        createdAt,
        displayName: dev.name,
        email: dev.email,
        githubId: BigInt(dev.githubId),
        githubLogin: dev.login,
        lastSeenAt: new Date(),
        orgRole: ('orgRole' in dev ? dev.orgRole : undefined) ?? 'MEMBER',
        passwordHash,
        primaryTeamId: team.id,
        visibilityPolicy: {
          create: {
            shareMetadataWithOrg: true,
            shareMetadataWithTeam: true,
            shareTranscriptsWithOrg: false,
            shareTranscriptsWithTeam: false,
          },
        },
      },
    });
    devUserMap.set(dev.login, u.id);
    await db.teamMember.create({ data: { roleInTeam: dev.role, teamId: team.id, userId: u.id } });
  }

  const pwHash = await hashPassword(SEED_PW_PASSWORD);
  const pwUser = await db.user.create({
    data: {
      displayName: 'Local Dev',
      email: SEED_PW_EMAIL,
      lastSeenAt: new Date(),
      passwordHash: pwHash,
      primaryTeamId: team.id,
      visibilityPolicy: {
        create: {
          shareMetadataWithOrg: true,
          shareMetadataWithTeam: true,
          shareTranscriptsWithOrg: false,
          shareTranscriptsWithTeam: false,
        },
      },
    },
  });
  await db.teamMember.create({ data: { roleInTeam: 'LEAD', teamId: team.id, userId: pwUser.id } });

  const adminHash = await hashPassword(SEED_ADMIN_PASSWORD);
  await db.user.create({
    data: {
      displayName: 'Org Admin',
      email: SEED_ADMIN_EMAIL,
      lastSeenAt: new Date(),
      orgRole: 'ORG_ADMIN',
      passwordHash: adminHash,
      primaryTeamId: team.id,
      visibilityPolicy: {
        create: {
          shareMetadataWithOrg: true,
          shareMetadataWithTeam: true,
          shareTranscriptsWithOrg: false,
          shareTranscriptsWithTeam: false,
        },
      },
    },
  });

  // ── Repos ─────────────────────────────────────────────────────────────────────
  const repoMap = new Map<string, string>(); // name → repoId

  for (const r of EXT_REPOS) {
    const repo = await db.repo.create({
      data: {
        defaultBranch: 'main',
        githubId: r.githubId,
        githubName: r.name,
        githubOwner: EXT_ORG,
        owningTeamId: team.id,
      },
    });
    repoMap.set(r.name, repo.id);
  }

  // ── Sessions ──────────────────────────────────────────────────────────────────
  const now = Date.now();
  let totalSessions = 0;
  const sessionsByDev = new Map<string, string[]>(); // login → sessionIds

  for (const dev of EXT_DEVS) {
    const devId = devUserMap.get(dev.login);
    if (!devId) {
      continue;
    }
    const devSessions: string[] = [];
    const baseCount = Math.max(1, Math.round(dev.avgPerDay));

    for (let daysAgo = dev.daysAgo; daysAgo >= 0; daysAgo--) {
      const date = new Date(now - daysAgo * 86_400_000);
      const isWeekend = date.getDay() === 0 || date.getDay() === 6;
      if (isWeekend && faker.datatype.boolean({ probability: 0.6 })) {
        continue;
      }

      const dayCount = faker.helpers.weightedArrayElement([
        { value: 0, weight: Math.max(5, 22 - baseCount * 4) },
        { value: 1, weight: 30 },
        { value: baseCount, weight: 38 },
        { value: baseCount + 1, weight: 20 },
        { value: baseCount + 2, weight: 7 },
      ]);

      for (let i = 0; i < dayCount; i++) {
        const repo = faker.helpers.arrayElement(EXT_REPOS);
        const repoId = repoMap.get(repo.name);
        if (!repoId) {
          continue;
        }
        const model = faker.helpers.weightedArrayElement(MODELS);
        const status = faker.helpers.weightedArrayElement(SESSION_STATUSES);
        const ccVersion = faker.helpers.arrayElement(CC_VERSIONS);

        const workdayOffset = faker.number.int({ max: 10 * 3_600_000, min: 7 * 3_600_000 });
        const startedAt = new Date(date.getTime() + workdayOffset + i * 3_600_000);

        let durationMs = weightedDurationMs();
        if (status === 'CRASHED') {
          durationMs = Math.round(durationMs * faker.number.float({ max: 0.5, min: 0.1 }));
        }
        if (status === 'TIMED_OUT') {
          durationMs = Math.round(durationMs * faker.number.float({ max: 2.5, min: 1.2 }));
        }
        if (status === 'ABANDONED') {
          durationMs = Math.round(durationMs * faker.number.float({ max: 0.8, min: 0.2 }));
        }

        const endedAt = new Date(startedAt.getTime() + durationMs);
        const inputTokens = faker.number.int({ max: 80000, min: 500 });
        const outputTokens = faker.number.int({ max: 15000, min: 200 });
        const cacheRead = faker.number.int({ max: 40000, min: 0 });
        const cacheCreation = faker.number.int({ max: 8000, min: 0 });
        const toolCalls = faker.number.int({ max: 120, min: 2 });

        const session = await db.session.create({
          data: {
            agentType: 'CLAUDE_CODE',
            agentVersion: ccVersion,
            claudeCodeVersion: ccVersion,
            compactionCount: faker.number.int({ max: 4, min: 0 }),
            cwd: `/home/${dev.login}/${repo.cwdSuffix}`,
            endedAt,
            frictionScore: faker.datatype.boolean({ probability: 0.3 })
              ? faker.number.float({ fractionDigits: 2, max: 1.0, min: 0.0 })
              : null,
            gitBranch: faker.helpers.arrayElement(repo.branches),
            gitCommit: faker.git.commitSha({ length: 40 }),
            gitIsDirty: faker.datatype.boolean({ probability: 0.3 }),
            isResume: faker.datatype.boolean({ probability: 0.08 }),
            lastEventAt: endedAt,
            os: faker.helpers.arrayElement(['darwin', 'darwin', 'linux']),
            permissionDenyCount: faker.number.int({ max: 5, min: 0 }),
            permissionPromptCount: faker.number.int({ max: 10, min: 0 }),
            primaryModel: model,
            repoId,
            sessionId: faker.string.uuid(),
            startedAt,
            status,
            toolCallCount: toolCalls,
            toolErrorCount: faker.number.int({ max: Math.floor(toolCalls * 0.12), min: 0 }),
            totalCacheCreation: BigInt(cacheCreation),
            totalCacheRead: BigInt(cacheRead),
            totalCostUsd: calcCost(inputTokens, outputTokens, cacheRead, cacheCreation),
            totalInputTokens: BigInt(inputTokens),
            totalOutputTokens: BigInt(outputTokens),
            userId: devId,
            userMessageCount: faker.number.int({ max: 30, min: 1 }),
          },
        });

        devSessions.push(session.sessionId);
        totalSessions++;

        await insertEvents(session.sessionId, devId, startedAt, durationMs, toolCalls, model);

        if (status === 'COMPLETED' && faker.datatype.boolean({ probability: 0.35 })) {
          await insertTranscript(session.sessionId, startedAt, durationMs);
          await uploadTranscriptToS3(session.sessionId, devId, startedAt, durationMs, model);
        }

        if (totalSessions % 50 === 0) {
          process.stdout.write(`  ${totalSessions} sessions created...\r`);
        }
      }
    }

    sessionsByDev.set(dev.login, devSessions);
  }

  // ── Pull Requests ─────────────────────────────────────────────────────────────
  for (const pr of EXT_PRS) {
    const repoId = repoMap.get(pr.repoName);
    if (!repoId) {
      continue;
    }
    const authorUserId = devUserMap.get(pr.authorLogin) ?? null;
    const openedAt = new Date(now - faker.number.int({ max: 60, min: 3 }) * 86_400_000);
    const isMerged = pr.state === 'MERGED';
    const isClosed = pr.state === 'CLOSED';
    const mergedAt = isMerged
      ? new Date(openedAt.getTime() + faker.number.int({ max: 4, min: 1 }) * 86_400_000)
      : null;
    const closedAt = isClosed
      ? new Date(openedAt.getTime() + faker.number.int({ max: 7, min: 1 }) * 86_400_000)
      : mergedAt;

    const otherLogins = EXT_DEVS.map((d) => d.login).filter((l) => l !== pr.authorLogin);
    const reviewerLogins = faker.helpers.arrayElements(otherLogins, { max: 2, min: 1 });

    await db.pullRequest.create({
      data: {
        authorGithubLogin: pr.authorLogin,
        authorUserId,
        baseBranch: 'main',
        closedAt,
        filesChanged: faker.number.int({ max: 35, min: 1 }),
        githubId: BigInt(20_000_000 + pr.number),
        headBranch: pr.headBranch,
        labels: pr.labels,
        linesAdded: faker.number.int({ max: 800, min: 5 }),
        linesRemoved: faker.number.int({ max: 400, min: 0 }),
        mergedAt,
        openedAt,
        prNumber: pr.number,
        repoId,
        reviewCount: faker.number.int({ max: 5, min: 1 }),
        reviewerLogins,
        state: pr.state,
        title: pr.title,
      },
    });

    const authorSessions = sessionsByDev.get(pr.authorLogin) ?? [];
    if (authorSessions.length > 0) {
      const linkCount = Math.min(faker.number.int({ max: 4, min: 2 }), authorSessions.length);
      const linkedSessions = faker.helpers.arrayElements(authorSessions, linkCount);

      for (const sessionId of linkedSessions) {
        await db.sessionPRLink.upsert({
          create: { linkSource: 'SESSION_START', prNumber: pr.number, repoId, sessionId },
          update: {},
          where: { sessionId_repoId_prNumber: { prNumber: pr.number, repoId, sessionId } },
        });
      }

      if (isMerged && mergedAt) {
        const contrib = linkedSessions.slice(0, Math.min(3, linkedSessions.length));
        await db.pRRollup.create({
          data: {
            contributingSessionIds: contrib,
            contributingUserIds: authorUserId ? [authorUserId] : [],
            costPerLoc: faker.number.float({ fractionDigits: 6, max: 0.08, min: 0.0005 }),
            firstSessionAt: openedAt,
            lastSessionAt: mergedAt,
            prNumber: pr.number,
            repoId,
            totalActiveSeconds: faker.number.int({ max: 14400, min: 300 }),
            totalCostUsd: faker.number.float({ fractionDigits: 4, max: 5.0, min: 0.05 }),
            totalInputTokens: BigInt(faker.number.int({ max: 150000, min: 5000 })),
            totalOutputTokens: BigInt(faker.number.int({ max: 30000, min: 1000 })),
            totalPermissionDenies: faker.number.int({ max: 10, min: 0 }),
            totalToolCalls: faker.number.int({ max: 500, min: 20 }),
            totalToolErrors: faker.number.int({ max: 20, min: 0 }),
          },
        });
      }
    }
  }

  const mergedCount = EXT_PRS.filter((p) => p.state === 'MERGED').length;
  console.log(`\nExtensive seed complete.`);
  console.log(`  Team    : ${EXT_ORG}`);
  console.log(`  Repos   : ${EXT_REPOS.map((r) => r.name).join(', ')}`);
  console.log(`  Sessions: ${totalSessions} across ${EXT_DEVS.length} devs`);
  console.log(`  PRs     : ${EXT_PRS.length} (${mergedCount} merged)`);
  console.log(`  Password user: ${SEED_PW_EMAIL} / ${SEED_PW_PASSWORD}`);
  console.log(`  Admin user   : ${SEED_ADMIN_EMAIL} / ${SEED_ADMIN_PASSWORD} (ORG_ADMIN)`);
  for (const dev of EXT_DEVS) {
    const count = sessionsByDev.get(dev.login)?.length ?? 0;
    console.log(`  ${dev.name.padEnd(15)}: ${dev.email} / ${dev.password}  (${count} sessions)`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (isExtensive) {
    await extensiveSeed();
  } else {
    await basicSeed();
  }
  await db.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
