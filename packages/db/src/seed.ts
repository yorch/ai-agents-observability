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
  { value: 'Bash', weight: 30 },
  { value: 'Read', weight: 22 },
  { value: 'Edit', weight: 18 },
  { value: 'Grep', weight: 9 },
  { value: 'Glob', weight: 5 },
  { value: 'Write', weight: 3 },
  { value: 'Agent', weight: 8 },
  { value: 'MultiEdit', weight: 5 },
  { value: 'WebFetch', weight: 3 },
  { value: 'WebSearch', weight: 2 },
];

const SUBAGENT_TYPES = [
  { value: 'Explore', weight: 25 },
  { value: 'code-reviewer', weight: 20 },
  { value: 'implementer', weight: 15 },
  { value: 'Plan', weight: 12 },
  { value: 'general-purpose', weight: 10 },
  { value: 'feature-dev:code-architect', weight: 8 },
  { value: 'guardian', weight: 5 },
  { value: 'feature-dev:code-reviewer', weight: 5 },
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

// ── HITL / autonomy coverage ──────────────────────────────────────────────────
// Canonical permission/autonomy modes (packages/schemas session-context.ts). The
// session-representative mode is the *most autonomous* observed, so we sample a
// per-event mode and reduce with AUTONOMY_RANK.
const PERMISSION_MODES = [
  { value: 'normal', weight: 55 },
  { value: 'plan', weight: 9 },
  { value: 'accept_edits', weight: 21 },
  { value: 'auto', weight: 7 },
  { value: 'dont_ask', weight: 5 },
  { value: 'bypass', weight: 3 },
];

const AUTONOMY_RANK: Record<string, number> = {
  accept_edits: 2,
  auto: 3,
  bypass: 5,
  dont_ask: 4,
  normal: 1,
  plan: 0,
};

// Notification-event classification (packages/schemas notification.ts). The three
// blocking kinds (permission/idle/elicitation) are the core "agent stopped for a
// human" signal that the oversight dashboards chart.
const NOTIFICATION_KINDS = [
  { value: 'permission', weight: 45 },
  { value: 'idle', weight: 28 },
  { value: 'elicitation', weight: 12 },
  { value: 'auth', weight: 8 },
  { value: 'other', weight: 7 },
];

// Session shape labels (packages/schemas effectiveness.ts classifySessionShape).
const SHAPE_LABELS = [
  'exploratory',
  'focused-edit',
  'debugging',
  'planning',
  'multi-tool',
  'minimal',
];

// Non-default agents. DESIGN_DOC ships Codex + OpenCode adapters; the adapter
// health + agent-comparison surfaces stay empty until sessions carry these.
const NON_DEFAULT_AGENTS = ['CODEX', 'OPENCODE'] as const;

// repo name → Jira project key, so session/PR jira_key values resolve to a real
// jira_issues row (roi-queries groups spend by ticket, quality-queries traverses).
const REPO_JIRA_PROJECT: Record<string, string> = {
  'api-service': 'API',
  'demo-app': 'PLAT',
  'infra-scripts': 'INFRA',
};

function pickMode(): string {
  return faker.helpers.weightedArrayElement(PERMISSION_MODES);
}

// The representative session mode = the most autonomous of a small per-session
// sample, matching how ingest derives sessions.mode from its events.
function representativeMode(): string {
  const samples = Array.from({ length: faker.number.int({ max: 4, min: 1 }) }, pickMode);
  return samples.reduce((a, b) => ((AUTONOMY_RANK[b] ?? 0) > (AUTONOMY_RANK[a] ?? 0) ? b : a));
}

function endReasonFor(status: string): string | null {
  switch (status) {
    case 'COMPLETED':
      return faker.helpers.arrayElement(['user_exit', 'clear', 'normal_stop']);
    case 'CRASHED':
      return faker.helpers.arrayElement(['crash:oom', 'crash:uncaught_exception', 'crash:sigkill']);
    case 'TIMED_OUT':
      return 'idle_timeout';
    case 'ABANDONED':
      return faker.helpers.arrayElement(['abandoned', 'window_closed']);
    default:
      return null;
  }
}

// The extra HITL / provenance columns shared by every extensive-seed session.
// Spread into the Prisma create so all three session loops stay in sync.
function hitlSessionFields(opts: {
  status: string;
  mode: string;
  userMessageCount: number;
  repoName?: string;
}) {
  const { status, mode, userMessageCount, repoName } = opts;
  const notificationCount = faker.number.int({ max: 7, min: 0 });
  const responseSampleCount =
    notificationCount > 0 ? faker.number.int({ max: notificationCount, min: 0 }) : 0;
  const totalResponseMs =
    responseSampleCount > 0
      ? BigInt(responseSampleCount * faker.number.int({ max: 90_000, min: 1_500 }))
      : BigInt(0);
  const project = repoName ? REPO_JIRA_PROJECT[repoName] : undefined;
  return {
    clearCount: faker.number.int({ max: 2, min: 0 }),
    endReason: endReasonFor(status),
    frictionScore: faker.datatype.boolean({ probability: 0.7 })
      ? faker.number.float({ fractionDigits: 2, max: 1.0, min: 0.0 })
      : null,
    gitRemoteUrl: repoName ? `git@github.com:${EXT_ORG}/${repoName}.git` : null,
    hostHash: faker.string.alphanumeric({ casing: 'lower', length: 16 }),
    interruptCount: faker.number.int({ max: Math.max(1, Math.ceil(userMessageCount / 4)), min: 0 }),
    jiraKey:
      project && faker.datatype.boolean({ probability: 0.4 })
        ? `${project}-${faker.number.int({ max: 8, min: 1 })}`
        : null,
    mode,
    notificationCount,
    responseSampleCount,
    shapeLabel: faker.helpers.arrayElement(SHAPE_LABELS),
    totalResponseMs,
  };
}

// ── Shared credential constants ───────────────────────────────────────────────

const SEED_PW_EMAIL = 'local@example.com';
const SEED_PW_PASSWORD = 'demo1234';
const SEED_ADMIN_EMAIL = 'admin@example.com';
const SEED_ADMIN_PASSWORD = 'admin1234';

// ── Extra teams for multi-team demo ──────────────────────────────────────────

const EXTRA_TEAMS = [
  {
    githubId: BigInt(3_000_001),
    githubSlug: 'demo-frontend',
    name: 'Frontend Team',
    repo: {
      cwdSuffix: 'projects/frontend-app',
      githubId: BigInt(555_777_001),
      name: 'frontend-app',
    },
    users: [
      {
        email: 'alice@frontend.example.com',
        name: 'Alice Chen',
        password: 'alice1234',
        role: 'LEAD' as const,
      },
      {
        email: 'bob@frontend.example.com',
        name: 'Bob Torres',
        password: 'bob1234',
        role: 'MEMBER' as const,
      },
    ],
  },
  {
    githubId: BigInt(3_000_002),
    githubSlug: 'demo-backend',
    name: 'Backend Team',
    repo: { cwdSuffix: 'projects/backend-api', githubId: BigInt(555_777_002), name: 'backend-api' },
    users: [
      {
        email: 'carol@backend.example.com',
        name: 'Carol Mbeki',
        password: 'carol1234',
        role: 'LEAD' as const,
      },
      {
        email: 'dave@backend.example.com',
        name: 'Dave Park',
        password: 'dave1234',
        role: 'MEMBER' as const,
      },
    ],
  },
];

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
  sessionMode = 'normal',
  agentType = 'CLAUDE_CODE',
) {
  const eventCount = faker.number.int({ max: Math.min(14, toolCallCount + 3), min: 3 });

  for (let e = 0; e < eventCount; e++) {
    const ts = new Date(
      startedAt.getTime() + Math.floor((e / Math.max(1, eventCount - 1)) * durationMs),
    );
    const eventId = crypto.randomUUID();
    // Most events run at the session's representative mode; a minority sample a
    // less-autonomous mode (the session mode is the *max* autonomy observed).
    const evtMode = faker.datatype.boolean({ probability: 0.8 }) ? sessionMode : pickMode();

    if (e === 0) {
      await db.$executeRaw`
        INSERT INTO events (event_id, session_id, user_id, ts, agent_type, event_type, model, mode)
        VALUES (${eventId}::uuid, ${sessionId}::uuid, ${userId}::uuid, ${ts},
                ${agentType}, 'SessionStart', ${model}, ${evtMode})
        ON CONFLICT (session_id, event_id, ts) DO NOTHING
      `;
    } else if (e === eventCount - 1) {
      await db.$executeRaw`
        INSERT INTO events (event_id, session_id, user_id, ts, agent_type, event_type, model, mode)
        VALUES (${eventId}::uuid, ${sessionId}::uuid, ${userId}::uuid, ${ts},
                ${agentType}, 'Stop', ${model}, ${evtMode})
        ON CONFLICT (session_id, event_id, ts) DO NOTHING
      `;
    } else if (e % 4 === 1) {
      const inputToks = faker.number.int({ max: 2000, min: 50 });
      const turnNum = Math.ceil(e / 4);
      await db.$executeRaw`
        INSERT INTO events (event_id, session_id, user_id, ts, agent_type, event_type, model, input_tokens, turn_number, mode)
        VALUES (${eventId}::uuid, ${sessionId}::uuid, ${userId}::uuid, ${ts},
                ${agentType}, 'UserPromptSubmit', ${model}, ${inputToks}, ${turnNum}, ${evtMode})
        ON CONFLICT (session_id, event_id, ts) DO NOTHING
      `;
    } else if (e % 6 === 3) {
      // Notification event — the agent stopped for a human (HITL oversight signal).
      const kind = faker.helpers.weightedArrayElement(NOTIFICATION_KINDS);
      const turnNum = Math.ceil(e / 4);
      await db.$executeRaw`
        INSERT INTO events (event_id, session_id, user_id, ts, agent_type, event_type,
                            notification_kind, turn_number, model, mode)
        VALUES (${eventId}::uuid, ${sessionId}::uuid, ${userId}::uuid, ${ts},
                ${agentType}, 'Notification', ${kind}, ${turnNum}, ${model}, ${evtMode})
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
      const cacheRead = faker.number.int({ max: 8000, min: 0 });
      const cacheCreation = faker.number.int({ max: 1500, min: 0 });
      const costVal = faker.number.float({ fractionDigits: 6, max: 0.02, min: 0.0001 });
      const turnNum = Math.ceil(e / 4);
      // Non-zero exit + interrupt correlate with an errored tool call.
      const exitStatus = wasDenied || faker.datatype.boolean({ probability: 0.05 }) ? 1 : 0;
      const wasInterrupted = faker.datatype.boolean({ probability: 0.03 });
      const useSkill = faker.datatype.boolean({ probability: 0.12 });
      const useMcp = !useSkill && faker.datatype.boolean({ probability: 0.06 });

      if (useSkill) {
        const { skillName, path: skillPath } = faker.helpers.weightedArrayElement(SKILL_NAMES);
        await db.$executeRaw`
          INSERT INTO events (event_id, session_id, user_id, ts, agent_type, event_type,
                              tool_name, tool_category, skill_name, slash_command, skill_path,
                              tool_duration_ms, tool_exit_status, output_tokens,
                              cache_read_tokens, cache_creation_tokens, cost_usd, turn_number, model, mode)
          VALUES (${eventId}::uuid, ${sessionId}::uuid, ${userId}::uuid, ${ts},
                  ${agentType}, 'PostToolUse',
                  'Skill', 'builtin', ${skillName}, ${skillName}, ${skillPath},
                  ${toolDurMs}, 0, ${outputToks},
                  ${cacheRead}, ${cacheCreation}, ${costVal}, ${turnNum}, ${model}, ${evtMode})
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
                              tool_name, tool_category, tool_duration_ms, tool_exit_status,
                              tool_was_denied, tool_was_interrupted, output_tokens,
                              cache_read_tokens, cache_creation_tokens, cost_usd,
                              mcp_server, mcp_tool, turn_number, model, mode)
          VALUES (${eventId}::uuid, ${sessionId}::uuid, ${userId}::uuid, ${ts},
                  ${agentType}, 'PostToolUse',
                  ${`mcp__${mcpServer}__${mcpTool}`}, 'mcp', ${toolDurMs}, ${exitStatus},
                  ${wasDenied}, ${wasInterrupted}, ${outputToks},
                  ${cacheRead}, ${cacheCreation}, ${costVal},
                  ${mcpServer}, ${mcpTool}, ${turnNum}, ${model}, ${evtMode})
          ON CONFLICT (session_id, event_id, ts) DO NOTHING
        `;
      } else if (toolName === 'Agent') {
        const subagentType = faker.helpers.weightedArrayElement(SUBAGENT_TYPES);
        const subagentDurMs = faker.number.int({ max: 120_000, min: 5_000 });
        const subagentOutputToks = faker.number.int({ max: 4000, min: 200 });
        const subagentCost = faker.number.float({ fractionDigits: 6, max: 0.15, min: 0.005 });
        await db.$executeRaw`
          INSERT INTO events (event_id, session_id, user_id, ts, agent_type, event_type,
                              tool_name, tool_category, subagent_type, tool_duration_ms,
                              tool_exit_status, tool_was_denied, output_tokens,
                              cache_read_tokens, cache_creation_tokens, cost_usd, turn_number, model, mode)
          VALUES (${eventId}::uuid, ${sessionId}::uuid, ${userId}::uuid, ${ts},
                  ${agentType}, 'PostToolUse',
                  'Agent', 'builtin', ${subagentType}, ${subagentDurMs},
                  ${exitStatus}, ${wasDenied}, ${subagentOutputToks},
                  ${cacheRead}, ${cacheCreation}, ${subagentCost}, ${turnNum}, ${model}, ${evtMode})
          ON CONFLICT (session_id, event_id, ts) DO NOTHING
        `;
      } else {
        await db.$executeRaw`
          INSERT INTO events (event_id, session_id, user_id, ts, agent_type, event_type,
                              tool_name, tool_category, tool_duration_ms, tool_exit_status,
                              tool_was_denied, tool_was_interrupted, output_tokens,
                              cache_read_tokens, cache_creation_tokens, cost_usd, turn_number, model, mode)
          VALUES (${eventId}::uuid, ${sessionId}::uuid, ${userId}::uuid, ${ts},
                  ${agentType}, 'PostToolUse',
                  ${toolName}, 'builtin', ${toolDurMs}, ${exitStatus},
                  ${wasDenied}, ${wasInterrupted}, ${outputToks},
                  ${cacheRead}, ${cacheCreation}, ${costVal}, ${turnNum}, ${model}, ${evtMode})
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
    await db.$executeRaw`DELETE FROM events WHERE user_id = ${existingAdmin.id}::uuid`;
    await db.session.deleteMany({ where: { userId: existingAdmin.id } });
    await db.auditLog.deleteMany({ where: { actorUserId: existingAdmin.id } });
    await db.user.delete({ where: { id: existingAdmin.id } });
  }
  await db.repo.deleteMany({ where: { githubOwner: 'demo-platform' } });
  if (existing) {
    await db.auditLog.deleteMany({ where: { actorUserId: existing.id } });
    await db.user.delete({ where: { id: existing.id } });
  }
  const existingTeam = await db.team.findUnique({ where: { githubSlug: 'demo-platform' } });
  if (existingTeam) {
    await db.team.delete({ where: { id: existingTeam.id } });
  }
  const team = await db.team.create({
    data: {
      githubId: BigInt(1234567),
      githubSlug: 'demo-platform',
      name: 'Platform Team',
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
      githubOwner: 'demo-platform',
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
      const mode = representativeMode();
      const userMessageCount = faker.number.int({ max: 25, min: 1 });

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
          userMessageCount,
          ...hitlSessionFields({ mode, repoName: 'demo-app', status, userMessageCount }),
        },
      });

      await insertEvents(
        adminSession.sessionId,
        adminUser.id,
        startedAt,
        durationMs,
        toolCalls,
        model,
        mode,
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

  console.log(`\nBasic seed complete.`);
  console.log(`\n  Platform Team`);
  console.log(`    repo: demo-app · ${sessions.length} sessions · 5 PRs`);
  console.log(`\n    ${'Email'.padEnd(30)}  ${'Password'.padEnd(12)}  Role`);
  console.log(`    ${'─'.repeat(60)}`);
  console.log(`    ${BASIC_EMAIL.padEnd(30)}  ${'[GitHub OAuth]'.padEnd(12)}  MEMBER  (demo-dev)`);
  console.log(`    ${SEED_PW_EMAIL.padEnd(30)}  ${SEED_PW_PASSWORD.padEnd(12)}  LEAD`);
  console.log(`    ${SEED_ADMIN_EMAIL.padEnd(30)}  ${SEED_ADMIN_PASSWORD.padEnd(12)}  ORG_ADMIN`);
}

// ── Extensive seed ────────────────────────────────────────────────────────────

const EXT_ORG = 'demo-platform';

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

// Users that exercise the remaining org/team roles + the deactivated state, so
// every OrgRole and TeamRole value appears in the seed (admin pages, role gating).
const EXTRA_ROLE_USERS = [
  {
    email: 'val@example.com',
    login: 'val-viewer',
    name: 'Val Osei',
    orgRole: 'VIEWER_AGGREGATE' as const,
    password: 'val1234',
    role: 'MEMBER' as const,
  },
  {
    email: 'ines@example.com',
    login: 'ines-investigator',
    name: 'Ines Rossi',
    orgRole: 'INVESTIGATOR' as const,
    password: 'ines1234',
    role: 'MEMBER' as const,
  },
  {
    email: 'mika@example.com',
    login: 'mika-maintainer',
    name: 'Mika Halla',
    orgRole: 'MEMBER' as const,
    password: 'mika1234',
    role: 'MAINTAINER' as const,
  },
  {
    // Left the org — exercises users.deactivated_at (adoption/active-user queries).
    deactivated: true,
    email: 'quinn@example.com',
    login: 'quinn-former',
    name: 'Quinn Alvarez',
    orgRole: 'MEMBER' as const,
    password: 'quinn1234',
    role: 'MEMBER' as const,
  },
];

async function extensiveSeed() {
  // ── Cleanup: standalone / ops / alert / jira tables (demo-only, safe to wipe) ──
  // These have no cascading FK to the seeded users, so re-running the seed must
  // clear them explicitly to stay idempotent.
  await db.jiraIssueLink.deleteMany({});
  await db.jiraIssue.deleteMany({});
  await db.jobRun.deleteMany({});
  await db.jobConfig.deleteMany({});
  await db.webhookDelivery.deleteMany({});
  await db.alertEvent.deleteMany({});
  await db.alertChannelConfig.deleteMany({});
  await db.alertDeliveryLog.deleteMany({});
  await db.sessionFeedback.deleteMany({});
  // Reset any leftover rule silence so re-runs start from a clean state.
  await db.alertRule.updateMany({ data: { silencedUntil: null }, where: {} });

  // ── Cleanup: EXTRA_ROLE_USERS ─────────────────────────────────────────────────
  const roleUserRows = await db.user.findMany({
    where: { email: { in: EXTRA_ROLE_USERS.map((u) => u.email) } },
  });
  const roleUserIds = roleUserRows.map((u: { id: string }) => u.id);
  if (roleUserIds.length > 0) {
    for (const uid of roleUserIds) {
      await db.$executeRaw`DELETE FROM events WHERE user_id = ${uid}::uuid`;
    }
    await db.session.deleteMany({ where: { userId: { in: roleUserIds } } });
    await db.auditLog.deleteMany({ where: { actorUserId: { in: roleUserIds } } });
    await db.user.deleteMany({ where: { id: { in: roleUserIds } } });
  }

  // ── Cleanup: EXT_DEVS ─────────────────────────────────────────────────────────
  const extEmails = EXT_DEVS.map((d) => d.email);
  const extLogins = EXT_DEVS.map((d) => d.login);
  const existingExtUsers = await db.user.findMany({
    where: { OR: [{ email: { in: extEmails } }, { githubLogin: { in: extLogins } }] },
  });
  const existingExtIds = existingExtUsers.map((u: { id: string }) => u.id);
  if (existingExtIds.length > 0) {
    for (const uid of existingExtIds) {
      await db.$executeRaw`DELETE FROM events WHERE user_id = ${uid}::uuid`;
    }
    await db.session.deleteMany({ where: { userId: { in: existingExtIds } } });
    await db.auditLog.deleteMany({ where: { actorUserId: { in: existingExtIds } } });
    await db.user.deleteMany({ where: { id: { in: existingExtIds } } });
  }

  // ── Cleanup: EXTRA_TEAMS ──────────────────────────────────────────────────────
  for (const teamDef of EXTRA_TEAMS) {
    const extraEmails = teamDef.users.map((u) => u.email);
    const extraUsers = await db.user.findMany({ where: { email: { in: extraEmails } } });
    const extraIds = extraUsers.map((u: { id: string }) => u.id);
    if (extraIds.length > 0) {
      for (const uid of extraIds) {
        await db.$executeRaw`DELETE FROM events WHERE user_id = ${uid}::uuid`;
      }
      await db.session.deleteMany({ where: { userId: { in: extraIds } } });
      await db.auditLog.deleteMany({ where: { actorUserId: { in: extraIds } } });
      await db.user.deleteMany({ where: { id: { in: extraIds } } });
    }
    await db.repo.deleteMany({ where: { githubOwner: teamDef.githubSlug } });
    await db.team.deleteMany({ where: { githubSlug: teamDef.githubSlug } });
  }

  // ── Cleanup: ext-only repos (basic will handle demo-platform repo + team) ──────────
  await db.repo.deleteMany({
    where: { githubName: { in: ['api-service', 'infra-scripts'] }, githubOwner: EXT_ORG },
  });

  // ── Build on top of basic seed ────────────────────────────────────────────────
  await basicSeed();
  const now = Date.now();

  // ── Look up entities created by basic ─────────────────────────────────────────
  const team = await db.team.findUniqueOrThrow({ where: { githubSlug: EXT_ORG } });
  const demoAppRepo = await db.repo.findFirstOrThrow({
    where: { githubName: 'demo-app', githubOwner: EXT_ORG },
  });
  const adminUser = await db.user.findUniqueOrThrow({ where: { email: SEED_ADMIN_EMAIL } });

  // ── EXTRA_TEAMS ───────────────────────────────────────────────────────────────
  for (const [teamIdx, teamDef] of EXTRA_TEAMS.entries()) {
    const extraTeam = await db.team.create({
      data: {
        githubId: teamDef.githubId,
        githubSlug: teamDef.githubSlug,
        name: teamDef.name,
        // Sub-teams of the Platform team — exercises the team hierarchy.
        parentTeamId: team.id,
        // One team overrides the global transcript retention (P9-004).
        retentionDays: teamIdx === 0 ? 30 : null,
        syncedAt: new Date(),
      },
    });
    const extraRepo = await db.repo.create({
      data: {
        defaultBranch: 'main',
        githubId: teamDef.repo.githubId,
        githubName: teamDef.repo.name,
        githubOwner: teamDef.githubSlug,
        owningTeamId: extraTeam.id,
      },
    });
    for (const userDef of teamDef.users) {
      const uHash = await hashPassword(userDef.password);
      const extraUser = await db.user.create({
        data: {
          displayName: userDef.name,
          email: userDef.email,
          lastSeenAt: new Date(),
          passwordHash: uHash,
          primaryTeamId: extraTeam.id,
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
        data: { roleInTeam: userDef.role, teamId: extraTeam.id, userId: extraUser.id },
      });
      for (let day = 29; day >= 0; day--) {
        const dayCount = faker.number.int({ max: 2, min: 1 });
        for (let i = 0; i < dayCount; i++) {
          const startedAt = new Date(
            now - day * 86_400_000 - faker.number.int({ max: 8 * 3_600_000, min: 0 }),
          );
          const durationMs = weightedDurationMs();
          const endedAt = new Date(startedAt.getTime() + durationMs);
          const inputTokens = faker.number.int({ max: 60000, min: 500 });
          const outputTokens = faker.number.int({ max: 12000, min: 200 });
          const cacheRead = faker.number.int({ max: 25000, min: 0 });
          const cacheCreation = faker.number.int({ max: 6000, min: 0 });
          const toolCalls = faker.number.int({ max: 100, min: 2 });
          const model = faker.helpers.weightedArrayElement(MODELS);
          const status = faker.helpers.weightedArrayElement(SESSION_STATUSES);
          const mode = representativeMode();
          const userMessageCount = faker.number.int({ max: 25, min: 1 });
          const extraSession = await db.session.create({
            data: {
              agentType: 'CLAUDE_CODE',
              agentVersion: faker.helpers.arrayElement(CC_VERSIONS),
              claudeCodeVersion: faker.helpers.arrayElement(CC_VERSIONS),
              cwd: `/home/${userDef.name.toLowerCase().replace(' ', '-')}/${teamDef.repo.cwdSuffix}`,
              endedAt,
              gitBranch: faker.helpers.arrayElement([
                'main',
                'feat/new-feature',
                'fix/bug',
                'chore/deps',
              ]),
              gitCommit: faker.git.commitSha({ length: 40 }),
              lastEventAt: endedAt,
              os: faker.helpers.arrayElement(['darwin', 'linux']),
              permissionDenyCount: faker.number.int({ max: 3, min: 0 }),
              permissionPromptCount: faker.number.int({ max: 8, min: 0 }),
              primaryModel: model,
              repoId: extraRepo.id,
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
              userId: extraUser.id,
              userMessageCount,
              ...hitlSessionFields({ mode, repoName: teamDef.repo.name, status, userMessageCount }),
            },
          });
          await insertEvents(
            extraSession.sessionId,
            extraUser.id,
            startedAt,
            durationMs,
            toolCalls,
            model,
            mode,
          );
          if (status === 'COMPLETED' && faker.datatype.boolean({ probability: 0.4 })) {
            await insertTranscript(extraSession.sessionId, startedAt, durationMs);
            await uploadTranscriptToS3(
              extraSession.sessionId,
              extraUser.id,
              startedAt,
              durationMs,
              model,
            );
          }
        }
      }
    }
  }

  // ── EXT_DEVS users ────────────────────────────────────────────────────────────
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

  // ── Repos ─────────────────────────────────────────────────────────────────────
  // demo-app already exists from basicSeed — look it up; create only the new ones.
  const repoMap = new Map<string, string>(); // name → repoId
  repoMap.set('demo-app', demoAppRepo.id);

  for (const r of EXT_REPOS) {
    if (r.name === 'demo-app') {
      continue;
    }
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

  // ── Sessions for EXT_DEVS ─────────────────────────────────────────────────────
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
        const mode = representativeMode();
        const isResume = faker.datatype.boolean({ probability: 0.08 });
        const userMessageCount = faker.number.int({ max: 30, min: 1 });
        // Chain a resumed session to a prior one from the same dev when available.
        const resumedFromSessionId =
          isResume && devSessions.length > 0
            ? (faker.helpers.arrayElement(devSessions) ?? null)
            : null;
        // Some sessions carry live PR/CI context (surfaced by the skill-CI-health query).
        const hasPrContext = faker.datatype.boolean({ probability: 0.25 });

        const session = await db.session.create({
          data: {
            agentType: 'CLAUDE_CODE',
            agentVersion: ccVersion,
            claudeCodeVersion: ccVersion,
            compactionCount: faker.number.int({ max: 4, min: 0 }),
            cwd: `/home/${dev.login}/${repo.cwdSuffix}`,
            endedAt,
            gitBranch: faker.helpers.arrayElement(repo.branches),
            gitCommit: faker.git.commitSha({ length: 40 }),
            githubLogin: dev.login,
            gitIsDirty: faker.datatype.boolean({ probability: 0.3 }),
            isResume,
            lastEventAt: endedAt,
            os: faker.helpers.arrayElement(['darwin', 'darwin', 'linux']),
            permissionDenyCount: faker.number.int({ max: 5, min: 0 }),
            permissionPromptCount: faker.number.int({ max: 10, min: 0 }),
            prCiStatus: hasPrContext
              ? faker.helpers.arrayElement(['SUCCESS', 'FAILURE', 'PENDING'])
              : null,
            primaryModel: model,
            prNumber: hasPrContext ? faker.number.int({ max: 405, min: 201 }) : null,
            prReviewDecision: hasPrContext
              ? faker.helpers.arrayElement(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED'])
              : null,
            repoId,
            resumedFromSessionId,
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
            userMessageCount,
            ...hitlSessionFields({ mode, repoName: repo.name, status, userMessageCount }),
          },
        });

        devSessions.push(session.sessionId);
        totalSessions++;

        await insertEvents(session.sessionId, devId, startedAt, durationMs, toolCalls, model, mode);

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
    const project = REPO_JIRA_PROJECT[pr.repoName];
    // Ticket key resolves to a seeded jira_issues row (see seedJira). PRs without
    // a key exercise the "no ticket" path in the ROI/quality joins.
    const jiraKey =
      project && faker.datatype.boolean({ probability: 0.75 })
        ? `${project}-${(pr.number % 8) + 1}`
        : null;
    const headSha = faker.git.commitSha({ length: 40 });

    await db.pullRequest.create({
      data: {
        authorGithubLogin: pr.authorLogin,
        authorUserId,
        baseBranch: 'main',
        closedAt,
        filesChanged: faker.number.int({ max: 35, min: 1 }),
        githubId: BigInt(20_000_000 + pr.number),
        headBranch: pr.headBranch,
        isDraft: pr.state === 'OPEN' ? faker.datatype.boolean({ probability: 0.3 }) : false,
        jiraKey,
        labels: pr.labels,
        linesAdded: faker.number.int({ max: 800, min: 5 }),
        linesRemoved: faker.number.int({ max: 400, min: 0 }),
        mergedAt,
        openedAt,
        prNumber: pr.number,
        repoId,
        reviewCount: reviewerLogins.length,
        reviewerLogins,
        state: pr.state,
        title: pr.title,
      },
    });

    // ── Check runs (CI health, org-queries getCheckRunHealth) ──
    const checkNames = faker.helpers.arrayElements(
      ['ci/build', 'ci/lint', 'ci/test', 'ci/typecheck'],
      { max: 4, min: 2 },
    );
    let checkFailures = 0;
    for (const [ci, name] of checkNames.entries()) {
      // Merged PRs almost always ended green; open/closed ones fail more often.
      const conclusion = isMerged
        ? faker.helpers.weightedArrayElement([
            { value: 'success', weight: 90 },
            { value: 'failure', weight: 6 },
            { value: 'neutral', weight: 4 },
          ])
        : faker.helpers.weightedArrayElement([
            { value: 'success', weight: 55 },
            { value: 'failure', weight: 35 },
            { value: 'neutral', weight: 10 },
          ]);
      if (conclusion === 'failure') {
        checkFailures++;
      }
      const checkStarted = new Date(
        openedAt.getTime() + faker.number.int({ max: 3600_000, min: 0 }),
      );
      await db.pRCheckRun.create({
        data: {
          completedAt: new Date(
            checkStarted.getTime() + faker.number.int({ max: 900_000, min: 30_000 }),
          ),
          conclusion,
          githubId: BigInt(70_000_000 + pr.number * 10 + ci),
          headSha,
          name,
          prNumber: pr.number,
          repoId,
          startedAt: checkStarted,
          status: 'completed',
        },
      });
    }

    // ── Reviews (review latency / burden, org-queries getReviewStats) ──
    for (const [ri, reviewer] of reviewerLogins.entries()) {
      const submittedAt = new Date(
        openedAt.getTime() + faker.number.int({ max: 3, min: 1 }) * 3_600_000,
      );
      await db.pRReview.create({
        data: {
          githubId: BigInt(80_000_000 + pr.number * 10 + ri),
          prNumber: pr.number,
          repoId,
          reviewerLogin: reviewer,
          state: isMerged
            ? faker.helpers.weightedArrayElement([
                { value: 'APPROVED', weight: 80 },
                { value: 'COMMENTED', weight: 20 },
              ])
            : faker.helpers.arrayElement(['CHANGES_REQUESTED', 'COMMENTED', 'APPROVED']),
          submittedAt,
        },
      });
    }

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
            checkFailuresCount: checkFailures,
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

        // Commit → session provenance (default-branch push attribution, ROI query).
        for (const sessionId of contrib) {
          await db.sessionCommitLink.create({
            data: {
              authorLogin: pr.authorLogin,
              commitSha: faker.git.commitSha({ length: 40 }),
              committedAt: new Date(
                mergedAt.getTime() - faker.number.int({ max: 3600_000, min: 0 }),
              ),
              repoId,
              sessionId,
            },
          });
        }
      }
    }
  }

  // Revert detection (P5-003): mark one merged demo-app PR as reverting an earlier
  // one so the revert/defect surfaces have a live example.
  const revertRepoId = repoMap.get('demo-app');
  if (revertRepoId) {
    await db.pullRequest
      .update({
        data: { revertOfPrNumber: 202 },
        where: { repoId_prNumber: { prNumber: 206, repoId: revertRepoId } },
      })
      .catch(() => undefined);
    await db.pullRequest
      .update({
        data: { revertedAt: new Date(now - 9 * 86_400_000) },
        where: { repoId_prNumber: { prNumber: 202, repoId: revertRepoId } },
      })
      .catch(() => undefined);
  }

  // ── Additional admin sessions (on top of what basic created) ──────────────────
  const adminRepo = EXT_REPOS[0];
  const adminRepoId = adminRepo ? repoMap.get(adminRepo.name) : undefined;
  let adminSessionCount = 0;
  if (adminRepo && adminRepoId) {
    for (let daysAgo = 20; daysAgo >= 0; daysAgo--) {
      const date = new Date(now - daysAgo * 86_400_000);
      const isWeekend = date.getDay() === 0 || date.getDay() === 6;
      if (isWeekend && faker.datatype.boolean({ probability: 0.7 })) {
        continue;
      }
      const dayCount = faker.number.int({ max: 2, min: 1 });
      for (let i = 0; i < dayCount; i++) {
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
        const mode = representativeMode();
        const userMessageCount = faker.number.int({ max: 30, min: 1 });
        const session = await db.session.create({
          data: {
            agentType: 'CLAUDE_CODE',
            agentVersion: ccVersion,
            claudeCodeVersion: ccVersion,
            compactionCount: faker.number.int({ max: 4, min: 0 }),
            cwd: `/home/admin/${adminRepo.cwdSuffix}`,
            endedAt,
            gitBranch: faker.helpers.arrayElement(adminRepo.branches),
            gitCommit: faker.git.commitSha({ length: 40 }),
            githubLogin: 'dave-lead',
            gitIsDirty: faker.datatype.boolean({ probability: 0.3 }),
            isResume: faker.datatype.boolean({ probability: 0.08 }),
            lastEventAt: endedAt,
            os: faker.helpers.arrayElement(['darwin', 'darwin', 'linux']),
            permissionDenyCount: faker.number.int({ max: 5, min: 0 }),
            permissionPromptCount: faker.number.int({ max: 10, min: 0 }),
            primaryModel: model,
            repoId: adminRepoId,
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
            userId: adminUser.id,
            userMessageCount,
            ...hitlSessionFields({ mode, repoName: adminRepo.name, status, userMessageCount }),
          },
        });
        totalSessions++;
        adminSessionCount++;
        await insertEvents(
          session.sessionId,
          adminUser.id,
          startedAt,
          durationMs,
          toolCalls,
          model,
          mode,
        );
        if (status === 'COMPLETED' && faker.datatype.boolean({ probability: 0.35 })) {
          await insertTranscript(session.sessionId, startedAt, durationMs);
          await uploadTranscriptToS3(session.sessionId, adminUser.id, startedAt, durationMs, model);
        }
      }
    }
  }

  // ── Extra-role users (VIEWER_AGGREGATE / INVESTIGATOR / MAINTAINER / deactivated) ──
  const roleUserMap = new Map<string, string>();
  for (const ru of EXTRA_ROLE_USERS) {
    const passwordHash = await hashPassword(ru.password);
    const created = await db.user.create({
      data: {
        createdAt: new Date(now - 90 * 86_400_000),
        deactivatedAt:
          'deactivated' in ru && ru.deactivated ? new Date(now - 14 * 86_400_000) : null,
        displayName: ru.name,
        email: ru.email,
        githubLogin: ru.login,
        lastSeenAt:
          'deactivated' in ru && ru.deactivated ? new Date(now - 14 * 86_400_000) : new Date(),
        orgRole: ru.orgRole,
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
    roleUserMap.set(ru.login, created.id);
    await db.teamMember.create({
      data: { roleInTeam: ru.role, teamId: team.id, userId: created.id },
    });
    // A few recent sessions each so they show up in rosters and adoption metrics.
    const active = !('deactivated' in ru && ru.deactivated);
    if (active) {
      for (let daysAgo = 6; daysAgo >= 0; daysAgo -= 2) {
        await createRichSession({
          agentType: 'CLAUDE_CODE',
          branches: demoAppRepo ? ['main', 'feat/roster', 'fix/gate'] : ['main'],
          cwd: `/home/${ru.login}/projects/demo-app`,
          durationMs: weightedDurationMs(),
          login: ru.login,
          model: faker.helpers.weightedArrayElement(MODELS),
          repoId: demoAppRepo.id,
          repoName: 'demo-app',
          startedAt: new Date(
            now - daysAgo * 86_400_000 - faker.number.int({ max: 6 * 3_600_000, min: 0 }),
          ),
          status: 'COMPLETED',
          userId: created.id,
        });
        totalSessions++;
      }
    }
  }

  // ── In-progress (ACTIVE) sessions — the live "running now" state ──────────────
  let activeCount = 0;
  for (const login of ['alice-coder', 'bob-engineer']) {
    const uid = devUserMap.get(login);
    if (!uid) {
      continue;
    }
    const startedAt = new Date(now - faker.number.int({ max: 25 * 60_000, min: 3 * 60_000 }));
    await createRichSession({
      active: true,
      branches: ['feat/live-work', 'main'],
      cwd: `/home/${login}/projects/demo-app`,
      durationMs: now - startedAt.getTime(),
      login,
      model: 'claude-sonnet-4-6',
      repoId: demoAppRepo.id,
      repoName: 'demo-app',
      startedAt,
      status: 'ACTIVE',
      userId: uid,
    });
    activeCount++;
    totalSessions++;
  }

  // ── Multi-agent sessions (Codex + OpenCode) — adapter-health + agent comparison ──
  // Recent so the adapters page marks them "active" (last 48h / 24h windows).
  let multiAgentCount = 0;
  const multiAgentDevs = ['carol-dev', 'eva-new', 'bob-engineer'];
  for (const agentType of NON_DEFAULT_AGENTS) {
    for (const login of multiAgentDevs) {
      const uid = devUserMap.get(login);
      if (!uid) {
        continue;
      }
      const sessionsForAgent = faker.number.int({ max: 4, min: 2 });
      for (let s = 0; s < sessionsForAgent; s++) {
        // Spread across the last ~3 days; the first is always within 24h.
        const startedAt = new Date(
          now - (s === 0 ? 1 : faker.number.int({ max: 72, min: 2 })) * 3_600_000,
        );
        await createRichSession({
          agentType,
          branches: ['main', 'feat/agent-task', 'fix/adapter'],
          cwd: `/home/${login}/projects/${agentType === 'CODEX' ? 'api-service' : 'demo-app'}`,
          durationMs: weightedDurationMs(),
          login,
          model:
            agentType === 'CODEX'
              ? faker.helpers.arrayElement(['gpt-5-codex', 'gpt-5'])
              : faker.helpers.arrayElement(['claude-sonnet-4-6', 'qwen-2.5-coder']),
          repoId:
            (agentType === 'CODEX' ? repoMap.get('api-service') : demoAppRepo.id) ?? demoAppRepo.id,
          repoName: agentType === 'CODEX' ? 'api-service' : 'demo-app',
          startedAt,
          status: faker.helpers.weightedArrayElement(SESSION_STATUSES),
          userId: uid,
        });
        multiAgentCount++;
        totalSessions++;
      }
    }
  }

  // ── Standalone surfaces: Jira, governance, ops, alert runtime ────────────────
  const investigatorId = roleUserMap.get('ines-investigator') ?? null;
  const governanceTargets = [devUserMap.get('alice-coder'), devUserMap.get('carol-dev')].filter(
    (v): v is string => Boolean(v),
  );
  const localUser = await db.user.findUnique({ where: { email: SEED_PW_EMAIL } });
  const demoUser = await db.user.findUnique({ where: { githubLogin: BASIC_LOGIN } });
  await seedJira();
  await seedOps();
  await seedAlertRuntime(adminUser.id);
  await seedGovernance({
    adminUserId: adminUser.id,
    demoUserId: demoUser?.id ?? null,
    granteeUserId: investigatorId ?? adminUser.id,
    localUserId: localUser?.id ?? null,
    targetUserIds: governanceTargets,
  });

  const mergedCount = EXT_PRS.filter((p) => p.state === 'MERGED').length;
  const totalTeams = 1 + EXTRA_TEAMS.length;
  const totalUsers =
    3 +
    EXT_DEVS.length +
    EXTRA_ROLE_USERS.length +
    EXTRA_TEAMS.reduce((n, t) => n + t.users.length, 0);
  console.log(`\nExtensive seed complete (builds on basic seed).`);
  console.log(
    `  ${totalTeams} teams · ${totalUsers} users · ${totalSessions} extensive sessions (+~120 from basic) · ${EXT_PRS.length} PRs (${mergedCount} merged)`,
  );
  console.log(
    `  coverage: ${activeCount} ACTIVE · ${multiAgentCount} Codex/OpenCode · ${roleUserMap.size} extra-role users · Jira + governance + alerts + ops seeded`,
  );

  console.log(`\n  Platform Team`);
  console.log(`    repos: ${EXT_REPOS.map((r) => r.name).join(', ')}`);
  console.log(`\n    ${'Email'.padEnd(32)}  ${'Password'.padEnd(12)}  Role`);
  console.log(`    ${'─'.repeat(64)}`);
  console.log(`    ${BASIC_EMAIL.padEnd(32)}  ${'[GitHub OAuth]'.padEnd(12)}  MEMBER  (demo-dev)`);
  console.log(`    ${SEED_PW_EMAIL.padEnd(32)}  ${SEED_PW_PASSWORD.padEnd(12)}  LEAD`);
  console.log(
    `    ${SEED_ADMIN_EMAIL.padEnd(32)}  ${SEED_ADMIN_PASSWORD.padEnd(12)}  ORG_ADMIN   +${adminSessionCount} sessions`,
  );
  for (const dev of EXT_DEVS) {
    const count = sessionsByDev.get(dev.login)?.length ?? 0;
    const orgTag = 'orgRole' in dev ? '  [ORG_ADMIN]' : '';
    console.log(
      `    ${dev.email.padEnd(32)}  ${dev.password.padEnd(12)}  ${dev.role.padEnd(8)}  ${String(count).padStart(3)} sessions${orgTag}`,
    );
  }
  for (const teamDef of EXTRA_TEAMS) {
    console.log(`\n  ${teamDef.name}`);
    console.log(`    repo: ${teamDef.repo.name}`);
    console.log(`\n    ${'Email'.padEnd(32)}  ${'Password'.padEnd(12)}  Role`);
    console.log(`    ${'─'.repeat(64)}`);
    for (const u of teamDef.users) {
      console.log(`    ${u.email.padEnd(32)}  ${u.password.padEnd(12)}  ${u.role}`);
    }
  }
}

// ── Rich-session helper (extra-role, ACTIVE, and multi-agent sessions) ────────

type SessionStatusLit = 'ACTIVE' | 'COMPLETED' | 'CRASHED' | 'TIMED_OUT' | 'ABANDONED';
type AgentTypeLit =
  | 'CLAUDE_CODE'
  | 'CURSOR'
  | 'AIDER'
  | 'COPILOT'
  | 'CODEX'
  | 'WINDSURF'
  | 'OPENCODE';

async function createRichSession(opts: {
  userId: string;
  repoId: string;
  repoName: string;
  login: string;
  cwd: string;
  startedAt: Date;
  durationMs: number;
  status: SessionStatusLit;
  model: string;
  branches: string[];
  agentType?: AgentTypeLit;
  active?: boolean;
}): Promise<string> {
  const { userId, repoId, repoName, login, cwd, startedAt, durationMs, status, model, branches } =
    opts;
  const agentType = opts.agentType ?? 'CLAUDE_CODE';
  const active = opts.active ?? false;
  const endedAt = active ? null : new Date(startedAt.getTime() + durationMs);
  const inputTokens = faker.number.int({ max: 80000, min: 500 });
  const outputTokens = faker.number.int({ max: 15000, min: 200 });
  const cacheRead = faker.number.int({ max: 40000, min: 0 });
  const cacheCreation = faker.number.int({ max: 8000, min: 0 });
  const toolCalls = faker.number.int({ max: 120, min: 2 });
  const userMessageCount = faker.number.int({ max: 30, min: 1 });
  const mode = representativeMode();
  const ccVersion = faker.helpers.arrayElement(CC_VERSIONS);
  const session = await db.session.create({
    data: {
      agentType,
      agentVersion: ccVersion,
      claudeCodeVersion: agentType === 'CLAUDE_CODE' ? ccVersion : null,
      compactionCount: faker.number.int({ max: 4, min: 0 }),
      cwd,
      endedAt,
      gitBranch: faker.helpers.arrayElement(branches),
      gitCommit: faker.git.commitSha({ length: 40 }),
      githubLogin: login,
      gitIsDirty: faker.datatype.boolean({ probability: 0.3 }),
      lastEventAt: active ? new Date() : (endedAt as Date),
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
      userId,
      userMessageCount,
      ...hitlSessionFields({ mode, repoName, status, userMessageCount }),
    },
  });
  await insertEvents(
    session.sessionId,
    userId,
    startedAt,
    durationMs,
    toolCalls,
    model,
    mode,
    agentType,
  );
  return session.sessionId;
}

// ── Jira issues + issue links ─────────────────────────────────────────────────

async function seedJira(): Promise<void> {
  const projects = [
    { key: 'PLAT', name: 'Platform Engineering' },
    { key: 'API', name: 'API Platform' },
    { key: 'INFRA', name: 'Infrastructure' },
  ];
  const issueTypes = [
    { value: 'Story', weight: 40 },
    { value: 'Bug', weight: 30 },
    { value: 'Task', weight: 20 },
    { value: 'Epic', weight: 10 },
  ];
  const statuses = ['To Do', 'In Progress', 'In Review', 'Done'];
  const assignees = ['alice-coder', 'bob-engineer', 'carol-dev', 'dave-lead', 'eva-new'];
  const allKeys: string[] = [];

  for (const p of projects) {
    const epicKey = `${p.key}-100`;
    await db.jiraIssue.create({
      data: {
        issueCreatedAt: new Date(Date.now() - 150 * 86_400_000),
        issueType: 'Epic',
        key: epicKey,
        projectKey: p.key,
        projectName: p.name,
        status: 'In Progress',
        summary: `${p.name} — quarterly initiative`,
        syncedAt: new Date(),
      },
    });
    for (let n = 1; n <= 8; n++) {
      const key = `${p.key}-${n}`;
      const issueType = faker.helpers.weightedArrayElement(issueTypes);
      const status = faker.helpers.arrayElement(statuses);
      const createdAt = new Date(Date.now() - faker.number.int({ max: 120, min: 10 }) * 86_400_000);
      await db.jiraIssue.create({
        data: {
          assignee: faker.helpers.arrayElement(assignees),
          epicKey,
          issueCreatedAt: createdAt,
          issueType,
          key,
          projectKey: p.key,
          projectName: p.name,
          resolvedAt:
            status === 'Done'
              ? new Date(createdAt.getTime() + faker.number.int({ max: 20, min: 1 }) * 86_400_000)
              : null,
          status,
          storyPoints: faker.helpers.arrayElement([1, 2, 3, 5, 8, 13]),
          summary: faker.git.commitMessage(),
          syncedAt: new Date(),
        },
      });
      allKeys.push(key);
    }
  }

  // Issue-to-issue links — the blast-radius traversal quality-queries walks.
  const linkKinds = [
    { description: 'blocks', linkType: 'Blocks' },
    { description: 'relates to', linkType: 'Relates' },
    { description: 'is caused by', linkType: 'Causes' },
  ];
  for (let i = 0; i < 8; i++) {
    const sourceKey = faker.helpers.arrayElement(allKeys);
    const targetKey = faker.helpers.arrayElement(allKeys);
    if (sourceKey === targetKey) {
      continue;
    }
    const kind = faker.helpers.arrayElement(linkKinds);
    await db.jiraIssueLink.upsert({
      create: { description: kind.description, linkType: kind.linkType, sourceKey, targetKey },
      update: {},
      where: {
        sourceKey_targetKey_linkType: { linkType: kind.linkType, sourceKey, targetKey },
      },
    });
  }
}

// ── Ops surfaces: job config/runs + webhook deliveries ────────────────────────

async function seedOps(): Promise<void> {
  const now = Date.now();
  const jobs = [
    { hour: 2, jobName: 'sweep-retention', minute: 0 },
    { hour: 3, jobName: 'index-transcripts', minute: 30 },
    { hour: 5, jobName: 'compute-effectiveness', minute: 0 },
    { hour: 1, jobName: 'evaluate-alerts', minute: 0 },
    { hour: 4, jobName: 'sync-teams', minute: 15 },
    { hour: 6, jobName: 'sync-jira', minute: 45 },
  ];
  for (const j of jobs) {
    await db.jobConfig.create({
      data: {
        enabled: j.jobName !== 'sync-jira',
        jobName: j.jobName,
        runHourUtc: j.hour,
        runMinuteUtc: j.minute,
      },
    });
    // A short history per job: several successes, an occasional error, one live run.
    const runs = faker.number.int({ max: 5, min: 2 });
    for (let r = 0; r < runs; r++) {
      const startedAt = new Date(
        now - (r + 1) * 86_400_000 - faker.number.int({ max: 3600_000, min: 0 }),
      );
      const outcome =
        r === 0 && faker.datatype.boolean({ probability: 0.2 })
          ? 'running'
          : faker.helpers.weightedArrayElement([
              { value: 'success', weight: 85 },
              { value: 'error', weight: 15 },
            ]);
      await db.jobRun.create({
        data: {
          errorText: outcome === 'error' ? 'timed out waiting for S3 HeadBucket' : null,
          finishedAt:
            outcome === 'running'
              ? null
              : new Date(startedAt.getTime() + faker.number.int({ max: 120_000, min: 500 })),
          jobName: j.jobName,
          startedAt,
          status: outcome,
        },
      });
    }
  }

  // Webhook deliveries (collected by the github-app) — pruned to recent history.
  const hookEvents = [
    { action: 'opened', eventType: 'pull_request' },
    { action: 'synchronize', eventType: 'pull_request' },
    { action: 'closed', eventType: 'pull_request' },
    { action: null, eventType: 'push' },
    { action: 'completed', eventType: 'check_run' },
    { action: 'submitted', eventType: 'pull_request_review' },
    { action: 'created', eventType: 'installation' },
  ];
  for (let i = 0; i < 24; i++) {
    const ev = faker.helpers.arrayElement(hookEvents);
    const status = faker.helpers.weightedArrayElement([
      { value: 'processed', weight: 80 },
      { value: 'ignored', weight: 15 },
      { value: 'error', weight: 5 },
    ]);
    const receivedAt = new Date(now - faker.number.int({ max: 10 * 86_400_000, min: 0 }));
    await db.webhookDelivery.create({
      data: {
        action: ev.action,
        deliveryId: faker.string.uuid(),
        errorText: status === 'error' ? 'handler threw: unexpected payload shape' : null,
        eventType: ev.eventType,
        processedAt: status === 'error' ? null : new Date(receivedAt.getTime() + 250),
        receivedAt,
        repo: faker.helpers.arrayElement(['demo-app', 'api-service', 'infra-scripts']),
        status,
      },
    });
  }
}

// ── Alert runtime: channels, firings, delivery log, one silenced rule ─────────

async function seedAlertRuntime(adminUserId: string): Promise<void> {
  const now = Date.now();
  await db.alertChannelConfig.create({
    data: {
      channelType: 'slack_webhook',
      config: { url: 'https://hooks.slack.com/services/T000/B000/demo' },
      enabled: true,
    },
  });
  await db.alertChannelConfig.create({
    data: { channelType: 'webhook', config: { url: 'https://example.com/alerts' }, enabled: true },
  });
  await db.alertChannelConfig.create({
    data: { channelType: 'email', config: { to: 'oncall@example.com' }, enabled: false },
  });

  const rules = await db.alertRule.findMany();
  const ruleByType = new Map(
    rules.map((r: { id: string; ruleType: string }) => [r.ruleType, r.id]),
  );

  // Silence one rule to exercise the silenced state.
  const spendRuleId = ruleByType.get('spend_spike');
  if (spendRuleId) {
    await db.alertRule.update({
      data: { silencedUntil: new Date(now + 4 * 3_600_000) },
      where: { id: spendRuleId },
    });
  }

  // Firings across a few rules: one open, one resolved, one acknowledged.
  const firings = [
    {
      acknowledged: false,
      details: { sigma: 3.4, windowSpendUsd: 812.5 },
      firedAt: new Date(now - 2 * 3_600_000),
      resolved: false,
      ruleType: 'spend_spike',
      severity: 'critical',
    },
    {
      acknowledged: true,
      details: { errorRate: 0.14, toolCalls: 1320 },
      firedAt: new Date(now - 26 * 3_600_000),
      resolved: true,
      ruleType: 'high_error_rate',
      severity: 'warn',
    },
    {
      acknowledged: false,
      details: { lowOversightShare: 0.58, sessions: 41 },
      firedAt: new Date(now - 3 * 86_400_000),
      resolved: true,
      ruleType: 'autonomy_surge',
      severity: 'warn',
    },
    {
      acknowledged: true,
      details: { unknownModelEvents: 73 },
      firedAt: new Date(now - 5 * 86_400_000),
      resolved: true,
      ruleType: 'unknown_model_surge',
      severity: 'warn',
    },
  ];
  for (const f of firings) {
    const ruleId = ruleByType.get(f.ruleType);
    if (!ruleId) {
      continue;
    }
    await db.alertEvent.create({
      data: {
        acknowledgedAt: f.acknowledged ? new Date(f.firedAt.getTime() + 30 * 60_000) : null,
        acknowledgedByUserId: f.acknowledged ? adminUserId : null,
        details: f.details,
        firedAt: f.firedAt,
        resolvedAt: f.resolved ? new Date(f.firedAt.getTime() + 2 * 3_600_000) : null,
        ruleId,
        severity: f.severity,
      },
    });
  }

  // Delivery attempts — some fail so the "recent delivery failures" panel renders.
  for (let i = 0; i < 8; i++) {
    const success = faker.datatype.boolean({ probability: 0.7 });
    await db.alertDeliveryLog.create({
      data: {
        attemptedAt: new Date(now - faker.number.int({ max: 7 * 86_400_000, min: 0 })),
        channelType: faker.helpers.arrayElement(['slack_webhook', 'webhook', 'email']),
        error: success
          ? null
          : faker.helpers.arrayElement([
              '503 from endpoint',
              'connection timeout',
              'invalid webhook url',
            ]),
        success,
      },
    });
  }
}

// ── Governance: audit log, access grants, deletion requests, session feedback ──

async function seedGovernance(opts: {
  adminUserId: string;
  granteeUserId: string;
  targetUserIds: string[];
  localUserId: string | null;
  demoUserId: string | null;
}): Promise<void> {
  const { adminUserId, granteeUserId, targetUserIds, localUserId, demoUserId } = opts;
  const now = Date.now();

  // Session ids to reference (targets of VIEW_SESSION audits + single-session grants).
  const sampleSessions = await db.session.findMany({
    select: { sessionId: true, userId: true },
    take: 40,
  });
  const sessionIds = sampleSessions.map((s: { sessionId: string }) => s.sessionId);

  // ── Audit log — spread across the action types, targeting real users/sessions ──
  const auditActions = [
    'VIEW_SESSION',
    'VIEW_TRANSCRIPT',
    'EXPORT_TEAM',
    'EXPORT_ORG',
    'ADMIN_IMPERSONATE',
    'HOOK_TOKEN_ISSUED',
    'ROLE_GRANT',
    'RETENTION_OVERRIDE_CHANGED',
    'GRANT_REQUESTED',
    'GRANT_APPROVED',
    'GRANT_REVOKED',
    'ALERT_ACKNOWLEDGED',
    'ALERT_SILENCED',
    'DELETE_REQUEST',
  ] as const;
  const auditTargets = [...targetUserIds, localUserId, demoUserId].filter((v): v is string =>
    Boolean(v),
  );
  for (let i = 0; i < 40; i++) {
    const action = faker.helpers.arrayElement(auditActions);
    const targetUserId = faker.helpers.arrayElement(auditTargets);
    const touchesSession =
      action === 'VIEW_SESSION' || action === 'VIEW_TRANSCRIPT' || action === 'ADMIN_IMPERSONATE';
    await db.auditLog.create({
      data: {
        action,
        actorUserId: faker.helpers.arrayElement([adminUserId, granteeUserId]),
        ip: faker.internet.ipv4(),
        justification: faker.helpers.arrayElement([
          'Investigating a cost anomaly',
          'Responding to a support request',
          'Quarterly access review',
          'User-requested export',
        ]),
        targetSessionId:
          touchesSession && sessionIds.length > 0 ? faker.helpers.arrayElement(sessionIds) : null,
        targetUserId,
        ts: new Date(now - faker.number.int({ max: 30 * 86_400_000, min: 0 })),
        userAgent: 'Mozilla/5.0 (seed)',
      },
    });
  }

  // ── Access grants — every status (pending / active / expired / revoked) ──
  const grantTarget = targetUserIds[0] ?? localUserId;
  if (grantTarget) {
    // pending
    await db.accessGrant.create({
      data: {
        granteeUserId,
        justification: 'Need to review recent sessions for an incident.',
        requestedAt: new Date(now - 2 * 3_600_000),
        scope: 'USER_SESSIONS',
        targetUserId: grantTarget,
      },
    });
    // active
    await db.accessGrant.create({
      data: {
        expiresAt: new Date(now + 3 * 86_400_000),
        grantedAt: new Date(now - 1 * 86_400_000),
        grantedByUserId: adminUserId,
        granteeUserId,
        justification: 'Approved: transcript review for defect attribution.',
        requestedAt: new Date(now - 1 * 86_400_000 - 3_600_000),
        scope: 'USER_SESSIONS',
        targetUserId: grantTarget,
      },
    });
    // expired
    await db.accessGrant.create({
      data: {
        expiresAt: new Date(now - 2 * 86_400_000),
        grantedAt: new Date(now - 9 * 86_400_000),
        grantedByUserId: adminUserId,
        granteeUserId,
        justification: 'Time-boxed access (now expired).',
        requestedAt: new Date(now - 9 * 86_400_000),
        scope: 'SINGLE_SESSION',
        targetSessionId: sessionIds[0] ?? null,
      },
    });
    // revoked
    await db.accessGrant.create({
      data: {
        expiresAt: new Date(now + 5 * 86_400_000),
        grantedAt: new Date(now - 4 * 86_400_000),
        grantedByUserId: adminUserId,
        granteeUserId,
        justification: 'Revoked after the investigation closed.',
        requestedAt: new Date(now - 4 * 86_400_000),
        revokedAt: new Date(now - 3 * 86_400_000),
        scope: 'SINGLE_SESSION',
        targetSessionId: sessionIds[1] ?? null,
      },
    });
  }

  // ── Deletion requests (GDPR) — one processed, one pending ──
  if (localUserId) {
    await db.deletionRequest.create({
      data: {
        processedAt: new Date(now - 20 * 86_400_000),
        reason: 'Test account cleanup',
        requestedAt: new Date(now - 21 * 86_400_000),
        userId: localUserId,
      },
    });
  }
  if (demoUserId) {
    await db.deletionRequest.create({
      data: {
        reason: 'User-requested erasure',
        requestedAt: new Date(now - 1 * 86_400_000),
        userId: demoUserId,
      },
    });
  }

  // ── Session feedback (HITL ground truth) — thumbs up/down on some sessions ──
  const feedbackSessions = sampleSessions.slice(0, 24);
  for (const s of feedbackSessions) {
    if (!faker.datatype.boolean({ probability: 0.6 })) {
      continue;
    }
    const sentiment = faker.helpers.weightedArrayElement([
      { value: 'up', weight: 70 },
      { value: 'down', weight: 30 },
    ]);
    await db.sessionFeedback.upsert({
      create: {
        note:
          sentiment === 'down'
            ? faker.helpers.arrayElement(['Went off track', 'Needed too much correction', null])
            : faker.helpers.arrayElement(['Nailed it', 'Saved me an hour', null]),
        sentiment,
        sessionId: s.sessionId,
        userId: s.userId,
      },
      update: { sentiment },
      where: { sessionId_userId: { sessionId: s.sessionId, userId: s.userId } },
    });
  }
}

// ── Post-seed telemetry finalization ────────────────────────────────────────
// Backfills columns/aggregates that the newer dashboards read but that the
// per-row inserts don't populate, so a freshly seeded DB drives every surface:
// granular tool categories + byte volumes (security & insights), transcript
// pointers + redaction classes (security secret-exposure), and the continuous
// aggregates the org cost rollups now read. Idempotent-ish: safe to re-run after
// a reseed. Operates on whatever basic/extensive seeded, so it runs once in main.
async function finalizeTelemetry() {
  console.log('  Finalizing telemetry (tool categories, byte volumes, redaction, aggregates)…');

  // 1. Granular tool_category from tool_name. The hook emits fs_read/exec/web/…;
  //    the per-row seed inserts a flat 'builtin'/'mcp'. Reclassify so the
  //    tool-category exposure, routing, and tool-usage views reflect the real
  //    taxonomy (DESIGN_DOC §5.3).
  await db.$executeRawUnsafe(`
    UPDATE events SET tool_category = CASE
      WHEN mcp_server IS NOT NULL THEN 'mcp'
      WHEN tool_name = 'Bash' THEN 'exec'
      WHEN tool_name = 'Read' THEN 'fs_read'
      WHEN tool_name IN ('Edit','Write','MultiEdit') THEN 'fs_write'
      WHEN tool_name IN ('Grep','Glob') THEN 'search'
      WHEN tool_name IN ('WebFetch','WebSearch') THEN 'web'
      WHEN tool_name = 'Agent' THEN 'task'
      ELSE 'other'
    END
    WHERE event_type = 'PostToolUse' AND tool_name IS NOT NULL
  `);

  // 2. Tool byte volumes — captured per event in prod, absent from the seed.
  //    web/mcp/fs_read carry larger outputs; a rare multi-MB spike feeds the
  //    "largest data movements" exfil-shaped signal on /org/security and the
  //    per-tool byte columns on /me/insights.
  await db.$executeRawUnsafe(`
    UPDATE events SET
      tool_input_bytes = 80 + floor(random() * 4000)::int,
      tool_output_bytes = CASE
        WHEN tool_category IN ('web','mcp') THEN
          1000 + floor(random() * 250000)::int
          + (CASE WHEN random() < 0.04 THEN floor(random() * 3000000)::int ELSE 0 END)
        WHEN tool_category = 'fs_read' THEN 400 + floor(random() * 90000)::int
        ELSE 100 + floor(random() * 16000)::int
      END
    WHERE event_type = 'PostToolUse' AND tool_name IS NOT NULL
  `);

  // 3. Transcript pointers on a realistic fraction of sessions that lack one. The
  //    showcase transcript is a real S3 upload; these are synthetic pointers so
  //    the transcript-dependent COUNTs (secret-exposure denominator) are coherent.
  //    (Their transcript *viewer* won't resolve in dev — the search/knowledge
  //    surfaces read transcript_index, which is seeded separately.)
  await db.$executeRawUnsafe(`
    UPDATE sessions SET
      transcript_s3_key = 'transcripts/seed/' || session_id::text || '.jsonl.zst',
      transcript_uploaded_at = COALESCE(transcript_uploaded_at, ended_at, last_event_at),
      transcript_redacted = true
    WHERE transcript_s3_key IS NULL AND random() < 0.4
  `);

  // 4. Redaction classes on ~30% of transcripted sessions — the secret-exposure
  //    signal /org/security groups by class. Each flagged session gets 1–2 classes.
  await db.$executeRawUnsafe(`
    UPDATE sessions s SET redaction_flags = sub.flags
    FROM (
      SELECT session_id, ARRAY(
        SELECT c FROM unnest(
          ARRAY['aws_key','github_pat','jwt','slack_token','generic_secret','private_key']
        ) AS c
        ORDER BY random() LIMIT (1 + floor(random() * 2)::int)
      ) AS flags
      FROM sessions
      WHERE transcript_s3_key IS NOT NULL AND random() < 0.3
    ) sub
    WHERE s.session_id = sub.session_id
  `);

  // 5. Materialize the continuous aggregates the org cost rollups now read
  //    (getWeeklyCostTrend / getCostByTeam / getCostPerDeveloper). A cagg created
  //    WITH NO DATA is otherwise empty until the hourly policy runs. Refresh can't
  //    run inside a txn; guarded so a non-Timescale dev DB doesn't fail the seed.
  for (const cagg of ['daily_cost_by_user', 'daily_cost_by_model', 'daily_tool_usage']) {
    try {
      await db.$executeRawUnsafe(`CALL refresh_continuous_aggregate('${cagg}', NULL, NULL)`);
    } catch (err) {
      console.warn(`  ⚠ could not refresh ${cagg}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (isExtensive) {
    await extensiveSeed();
  } else {
    await basicSeed();
  }
  await finalizeTelemetry();
  await db.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
