import type { Prisma } from '@ai-agents-observability/db';
import type { Event, GitContext, PriceTable } from '@ai-agents-observability/schemas';
import { describe, expect, it, vi } from 'vitest';

import { upsertSessions } from '../src/lib/upsert-session';

type UpsertDb = Parameters<typeof upsertSessions>[0];

const PRICE_TABLE: PriceTable = {
  generated_at: '2026-05-01T00:00:00+00:00',
  prices: {},
  version: '1',
};

const PRICE_TABLES = { forAgentParam: () => PRICE_TABLE, resolve: () => PRICE_TABLE };

const SESSION_ID = '01906a44-0000-7000-8000-000000000000';
const USER_ID = '00000000-0000-7000-8000-000000000001';

function makeGit(overrides: Partial<GitContext> = {}): GitContext {
  return {
    branch: 'main',
    commit: 'abc123',
    is_dirty: false,
    owner: 'myorg',
    pr_number: null,
    remote_url: 'https://github.com/myorg/myrepo.git',
    repo: 'myrepo',
    ...overrides,
  };
}

function stopEvent(git: GitContext | null): Event {
  return {
    agent_type: 'CLAUDE_CODE',
    client: { claude_code_version: '1.0.0', hostname_hash: 'sha256:abc', os: 'linux' },
    event_id: '01906a44-0000-7000-8000-0000000000aa',
    event_type: 'Stop',
    metadata: {},
    redaction_flags: [],
    schema_version: 1,
    session_context: { cwd: '/repo', git, is_resume: false, mode: 'normal' },
    session_id: SESSION_ID,
    ts: '2026-05-21T12:00:00Z',
    user_id_claim: USER_ID,
  };
}

function makeDb() {
  const captured: { params: unknown[]; sql: string }[] = [];
  return {
    $executeRaw: vi.fn(async (query: Prisma.Sql) => {
      captured.push({ params: [...query.values], sql: query.sql });
      return 1;
    }) as unknown as UpsertDb['$executeRaw'],
    // `$queryRaw` is generic in its row type (`<T>(q) => Promise<T>`) — a
    // signature no concrete double can implement.
    $queryRaw: vi.fn(async (query: Prisma.Sql) => {
      captured.push({ params: [...query.values], sql: query.sql });
      return [];
    }) as unknown as UpsertDb['$queryRaw'],
    captured,
  };
}

/** Returns the git_remote_url parameter value from the captured INSERT. */
function capturedGitRemoteUrl(db: ReturnType<typeof makeDb>): unknown {
  const insert = db.captured.find((c) => c.sql.includes('INSERT INTO sessions'));
  expect(insert).toBeDefined();
  // git_remote_url is the 18th column in the INSERT (0-indexed: 17). Find it
  // by scanning the SQL for the column name position instead of hardcoding.
  const sql = insert?.sql ?? '';
  const colIdx = sql.indexOf('git_remote_url');
  expect(colIdx).toBeGreaterThan(-1);
  // The params array follows the column order in the VALUES clause. We find
  // git_remote_url's position by counting columns from the start of the INSERT
  // column list. The params correspond 1:1 to the placeholder order.
  // Instead of counting, just search for the redacted marker or the raw URL.
  return insert?.params.find(
    (p) => typeof p === 'string' && (p.includes('REDACTED') || p.includes('github.com')),
  );
}

describe('upsertSessions redacts credentials in git_remote_url', () => {
  it('strips embedded token from https://token@host URLs', async () => {
    const db = makeDb();
    const urlWithCred = 'https://ghp_secrettoken123@github.com/myorg/myrepo.git';
    const event = stopEvent(makeGit({ remote_url: urlWithCred }));

    await upsertSessions(db, [event], USER_ID, new Map(), PRICE_TABLES);

    const value = capturedGitRemoteUrl(db);
    expect(value).toBe('https://[REDACTED:git-remote-url]@github.com/myorg/myrepo.git');
    expect(value).not.toContain('ghp_secrettoken123');
  });

  it('strips user:password from https://user:pass@host URLs', async () => {
    const db = makeDb();
    const urlWithCred = 'https://jenkins:secretpass@gitlab.com/team/project.git';
    const event = stopEvent(makeGit({ remote_url: urlWithCred }));

    await upsertSessions(db, [event], USER_ID, new Map(), PRICE_TABLES);

    const value = capturedGitRemoteUrl(db);
    expect(value).toBe('https://[REDACTED:git-remote-url]@gitlab.com/team/project.git');
    expect(value).not.toContain('secretpass');
  });

  it('preserves URLs without credentials unchanged', async () => {
    const db = makeDb();
    const cleanUrl = 'https://github.com/myorg/myrepo.git';
    const event = stopEvent(makeGit({ remote_url: cleanUrl }));

    await upsertSessions(db, [event], USER_ID, new Map(), PRICE_TABLES);

    const value = capturedGitRemoteUrl(db);
    expect(value).toBe(cleanUrl);
  });

  it('redacts credentials from the envelope git fallback when event git is null', async () => {
    const db = makeDb();
    const urlWithCred = 'https://token@github.com/myorg/myrepo.git';
    const event = stopEvent(null);
    const envelopeGit = makeGit({ remote_url: urlWithCred });

    await upsertSessions(db, [event], USER_ID, new Map(), PRICE_TABLES, envelopeGit);

    const value = capturedGitRemoteUrl(db);
    expect(value).toBe('https://[REDACTED:git-remote-url]@github.com/myorg/myrepo.git');
    expect(value).not.toContain('token');
  });
});
