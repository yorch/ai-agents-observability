import { gzipSync } from 'node:zlib';

import type { PrismaClient } from '@ai-agents-observability/db';
import { resolveJudgeRevision } from '@ai-agents-observability/schemas';
import type { S3Client } from '@aws-sdk/client-s3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  JUDGE_OWN_SESSIONS_ONLY,
  type JudgeRunConfig,
  judgeOneSession,
  runJudgeSessions,
  selectJudgeCandidates,
} from '../src/jobs/judge-sessions.ts';
import { AnthropicJudgeClient, type JudgeModelClient } from '../src/lib/judge-client.ts';
import { judgeRationaleKey, purgeJudgeRationales } from '../src/lib/judge-rationales.ts';

/**
 * The guardrails are the acceptance criteria of P13-009, so they are what this
 * file tests: the two independent guards, the fetch-time re-check, the audit
 * write that precedes every read, and the fact that a judge reply which fails
 * the schema writes nothing.
 *
 * The mock database emulates Postgres for exactly the predicates under test: it
 * reads the emitted SQL, sees which guard fragments are present, and applies
 * them to its fixture rows. That is deliberate — it means a test fails both if
 * the guard stops filtering *and* if the guard disappears from the query.
 */

const OPERATOR = '11111111-1111-1111-1111-111111111111';
const STRANGER = '22222222-2222-2222-2222-222222222222';

const OWN_SESSION = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const STRANGER_SESSION = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

const REVISION = resolveJudgeRevision('claude-opus-5');
if (!REVISION) {
  throw new Error('test fixture: claude-opus-5 must be a registered judge revision');
}

const VERDICT = JSON.stringify({
  plan_coherence: { label: 'mixed', rationale: 'Two approaches before one stuck.' },
  task_completion: { label: 'partly', rationale: 'Ran the migration, never ran the tests.' },
});

type SessionFixture = {
  agentType: string;
  allowJudgeAnalysis: boolean;
  sessionId: string;
  transcriptS3Key: string;
  userId: string;
};

function fixtures(): SessionFixture[] {
  return [
    {
      agentType: 'CLAUDE_CODE',
      allowJudgeAnalysis: true,
      sessionId: OWN_SESSION,
      transcriptS3Key: `transcripts/${OWN_SESSION}.jsonl.gz`,
      userId: OPERATOR,
    },
    {
      agentType: 'CLAUDE_CODE',
      allowJudgeAnalysis: false,
      sessionId: STRANGER_SESSION,
      transcriptS3Key: `transcripts/${STRANGER_SESSION}.jsonl.gz`,
      userId: STRANGER,
    },
  ];
}

function introspect(arg0: unknown): { text: string; values: unknown[] } {
  const sql = arg0 as { sql?: string; strings?: string[]; values?: unknown[] };
  const text = sql.strings ? sql.strings.join(' ') : (sql.sql ?? String(arg0));
  return { text, values: sql.values ?? [] };
}

type Captured = {
  costUsd: unknown;
  label: string;
  rationaleRef: unknown;
  scorerName: string;
  scorerVersion: number;
  subjectId: string;
};

function makeMockDb(sessions: SessionFixture[], hooks: { onSelect?: () => void } = {}) {
  const audits: { action: string; targetSessionId: string; targetUserId: string }[] = [];
  const scores: Captured[] = [];
  const ops: string[] = [];
  let auditShouldFail = false;

  const db = {
    _audits: audits,
    _failAudits: () => {
      auditShouldFail = true;
    },
    _ops: ops,
    _scores: scores,
    _sessions: sessions,
    $executeRaw: vi.fn(async (arg0: unknown) => {
      const { text, values } = introspect(arg0);
      if (text.includes('INSERT INTO scores')) {
        const [, subjectId, scorerName, scorerVersion, , , label, , rationaleRef, costUsd] =
          values as [
            string,
            string,
            string,
            number,
            string,
            unknown,
            string,
            string,
            string,
            number,
          ];
        scores.push({ costUsd, label, rationaleRef, scorerName, scorerVersion, subjectId });
        ops.push('score');
      }
      return 1;
    }),
    $queryRaw: vi.fn(async (arg0: unknown) => {
      const { text, values } = introspect(arg0);

      if (text.includes('pg_try_advisory_lock')) {
        return [{ pg_try_advisory_lock: true }];
      }
      if (text.includes('pg_advisory_unlock')) {
        return [{ pg_advisory_unlock: true }];
      }

      // Fetch-time re-check (matched first: its SQL also contains "FROM
      // sessions s"). Returns raw state; the guards themselves run in
      // TypeScript, so this is the real code path, not an emulation.
      if (text.includes('LEFT JOIN visibility_policies')) {
        ops.push('recheck');
        const id = values[0] as string;
        const row = sessions.find((s) => s.sessionId === id);
        return row ? [{ allow_judge_analysis: row.allowJudgeAnalysis, user_id: row.userId }] : [];
      }

      // Candidate selection. Guard emulation: apply exactly the predicates the
      // emitted SQL actually contains.
      if (
        text.includes('FROM interactive_sessions s') &&
        text.includes('JOIN visibility_policies')
      ) {
        ops.push('select');
        const consentGuard = text.includes('vp.allow_judge_analysis = TRUE');
        const ownerGuard = text.includes('s.user_id =') && values.includes(OPERATOR);
        const rows = sessions
          .filter((s) => !consentGuard || s.allowJudgeAnalysis)
          .filter((s) => !ownerGuard || s.userId === OPERATOR)
          .map((s) => ({
            agent_type: s.agentType,
            session_id: s.sessionId,
            transcript_s3_key: s.transcriptS3Key,
          }));
        hooks.onSelect?.();
        return rows;
      }

      return [];
    }),
    $transaction: vi.fn(async (statements: Promise<unknown>[]) => Promise.all(statements)),
    auditLog: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        if (auditShouldFail) {
          throw new Error('audit write failed');
        }
        ops.push('audit');
        audits.push({
          action: String(args.data.action),
          targetSessionId: String(args.data.targetSessionId),
          targetUserId: String(args.data.targetUserId),
        });
        return args.data;
      }),
    },
    jobRun: {
      create: vi.fn(async () => ({ id: 1n })),
      update: vi.fn(async () => ({})),
    },
  };

  return db;
}

type MockDb = ReturnType<typeof makeMockDb>;

function transcriptBody(): Uint8Array {
  const lines = [
    JSON.stringify({ content: 'please fix the failing migration', role: 'user' }),
    JSON.stringify({ content: 'ran the migration; tests untouched', role: 'assistant' }),
  ].join('\n');
  return new Uint8Array(gzipSync(Buffer.from(lines, 'utf8')));
}

function makeMockS3(ops: string[]) {
  const gets: string[] = [];
  const puts: { body: string; key: string }[] = [];

  const client = {
    _gets: gets,
    _puts: puts,
    send: vi.fn(async (cmd: { input: Record<string, unknown> }) => {
      const input = cmd.input;
      if (typeof input.Body === 'string') {
        ops.push('put');
        puts.push({ body: input.Body, key: String(input.Key) });
        return {};
      }
      if (input.Delete) {
        return { Deleted: [] };
      }
      ops.push('get');
      gets.push(String(input.Key));
      return { Body: { transformToByteArray: async () => transcriptBody() } };
    }),
  };
  return client;
}

function makeJudgeClient(reply: string = VERDICT) {
  const calls: { system: string; user: string }[] = [];
  const client: JudgeModelClient = {
    complete: vi.fn(async (args: { system: string; user: string }) => {
      calls.push({ system: args.system, user: args.user });
      return {
        text: reply,
        usage: { inputTokens: 10_000, outputTokens: 200 },
      };
    }) as unknown as JudgeModelClient['complete'],
  };
  return { calls, client };
}

function makeConfig(overrides: Partial<JudgeRunConfig> = {}): JudgeRunConfig {
  return {
    highCostUsd: 5,
    maxSessionsPerRun: 25,
    operatorUserId: OPERATOR,
    revision: REVISION,
    sampleRate: 0.1,
    ...overrides,
  };
}

async function run(db: MockDb, config: JudgeRunConfig, judge = makeJudgeClient()) {
  const s3 = makeMockS3(db._ops);
  await runJudgeSessions(
    db as unknown as Parameters<typeof runJudgeSessions>[0],
    s3 as unknown as S3Client,
    'transcripts',
    config,
    judge.client,
  );
  return { judge, s3 };
}

describe('judge candidate selection', () => {
  it('carries both guards, so an ineligible session is never even listed', async () => {
    const db = makeMockDb(fixtures());
    const rows = await selectJudgeCandidates(
      db as unknown as Pick<PrismaClient, '$queryRaw'>,
      makeConfig(),
    );

    expect(rows.map((r) => r.session_id)).toEqual([OWN_SESSION]);

    const { text, values } = introspect(db.$queryRaw.mock.calls[0]?.[0]);
    expect(text).toContain('vp.allow_judge_analysis = TRUE');
    expect(text).toContain('s.user_id =');
    expect(values).toContain(OPERATOR);
  });

  it('always includes outcome-negative sessions, sampling only the rest', async () => {
    const db = makeMockDb(fixtures());
    await selectJudgeCandidates(
      db as unknown as Pick<PrismaClient, '$queryRaw'>,
      makeConfig({ sampleRate: 0.15 }),
    );
    const { text, values } = introspect(db.$queryRaw.mock.calls[0]?.[0]);

    expect(text).toContain('pr.reverted_at IS NOT NULL');
    expect(text).toContain('s.pr_ci_status = ANY');
    expect(text).toContain("s.status = 'ABANDONED'");
    // Deterministic hash sampler at 15% → 1500 of 10000 buckets.
    expect(text).toContain('hashtext');
    expect(values).toContain(1500);
  });

  it('skips sessions already judged at this scorer version', async () => {
    const db = makeMockDb(fixtures());
    await selectJudgeCandidates(db as unknown as Pick<PrismaClient, '$queryRaw'>, makeConfig());
    const { text, values } = introspect(db.$queryRaw.mock.calls[0]?.[0]);
    expect(text).toContain('FROM scores sc');
    expect(values).toContain(REVISION.scorerVersion);
  });

  it('reads only interactive runs with a transcript', async () => {
    const db = makeMockDb(fixtures());
    await selectJudgeCandidates(db as unknown as Pick<PrismaClient, '$queryRaw'>, makeConfig());
    const { text } = introspect(db.$queryRaw.mock.calls[0]?.[0]);
    // Since P13-012 the filter is the relation, not a predicate: reading
    // `interactive_sessions` is what excludes CI and eval runs. A revert to the
    // base table would reintroduce them silently, so assert on the table name.
    expect(text).toContain('FROM interactive_sessions s');
    expect(text).not.toMatch(/FROM sessions\b/);
    expect(text).toContain('s.transcript_s3_key IS NOT NULL');
  });
});

describe('the two guards are independent', () => {
  it('own-sessions-only is on by default', () => {
    expect(JUDGE_OWN_SESSIONS_ONLY).toBe(true);
  });

  it('blocks a consenting third party when only the own-sessions guard is left', async () => {
    // Guard 1 neutralized by granting consent; guard 2 must still block.
    const sessions = fixtures().map((s) => ({ ...s, allowJudgeAnalysis: true }));
    const db = makeMockDb(sessions);
    const { s3 } = await run(db, makeConfig({ ownSessionsOnly: true }));

    expect(s3._gets).not.toContain(`transcripts/${STRANGER_SESSION}.jsonl.gz`);
    expect(db._audits.map((a) => a.targetSessionId)).not.toContain(STRANGER_SESSION);
    expect(db._scores.map((s) => s.subjectId)).not.toContain(STRANGER_SESSION);
    // …and the operator's own session IS judged, so this proves guard 2 blocked
    // the stranger rather than the run doing nothing at all. Without this line an
    // over-blocking bug (reject everyone whenever the guard is on) satisfies every
    // assertion above — "nothing happened" is trivially true when nothing happens.
    expect(s3._gets).toContain(`transcripts/${OWN_SESSION}.jsonl.gz`);
  });

  it('blocks a non-consenting third party when only the consent guard is left', async () => {
    // Guard 2 removed the way P13-011 would remove it; guard 1 must still block.
    const db = makeMockDb(fixtures());
    const { s3 } = await run(db, makeConfig({ ownSessionsOnly: false }));

    expect(s3._gets).not.toContain(`transcripts/${STRANGER_SESSION}.jsonl.gz`);
    expect(db._audits.map((a) => a.targetSessionId)).not.toContain(STRANGER_SESSION);
    expect(db._scores.map((s) => s.subjectId)).not.toContain(STRANGER_SESSION);
    // …and the operator's own consented session is still judged, so the test
    // proves the consent guard blocked rather than the run doing nothing.
    expect(s3._gets).toContain(`transcripts/${OWN_SESSION}.jsonl.gz`);
  });

  it('blocks a third party at fetch time even if selection somehow yielded them', async () => {
    const db = makeMockDb(fixtures());
    const judge = makeJudgeClient();
    const s3 = makeMockS3(db._ops);

    const written = await judgeOneSession(
      db as unknown as Parameters<typeof judgeOneSession>[0],
      s3 as unknown as S3Client,
      'transcripts',
      {
        agent_type: 'CLAUDE_CODE',
        session_id: STRANGER_SESSION,
        transcript_s3_key: `transcripts/${STRANGER_SESSION}.jsonl.gz`,
      },
      makeConfig(),
      judge.client,
    );

    expect(written).toBe(false);
    expect(s3._gets).toEqual([]);
    expect(db._audits).toEqual([]);
    expect(judge.calls).toEqual([]);
  });
});

describe('consent revoked between selection and fetch', () => {
  it('does not read a transcript whose owner withdrew consent after selection', async () => {
    const sessions = fixtures();
    // The revocation lands the moment the candidate list is produced — exactly
    // the window a single up-front check would miss.
    const db = makeMockDb(sessions, {
      onSelect: () => {
        const own = sessions.find((s) => s.sessionId === OWN_SESSION);
        if (own) {
          own.allowJudgeAnalysis = false;
        }
      },
    });

    const { s3 } = await run(db, makeConfig());

    expect(db._ops).toContain('select');
    expect(db._ops).toContain('recheck');
    expect(s3._gets).toEqual([]);
    expect(db._audits).toEqual([]);
    expect(db._scores).toEqual([]);
  });
});

describe('auditing', () => {
  it('writes an audit row addressed to the subject before any read', async () => {
    const db = makeMockDb(fixtures());
    await run(db, makeConfig());

    expect(db._audits).toEqual([
      {
        action: 'JUDGE_READ_TRANSCRIPT',
        targetSessionId: OWN_SESSION,
        targetUserId: OPERATOR,
      },
    ]);
    // Order is the guarantee: audit strictly precedes the S3 fetch.
    expect(db._ops.indexOf('audit')).toBeLessThan(db._ops.indexOf('get'));
  });

  it('refuses to read when the audit row cannot be written', async () => {
    const db = makeMockDb(fixtures());
    db._failAudits();
    const { s3 } = await run(db, makeConfig());

    expect(s3._gets).toEqual([]);
    expect(db._scores).toEqual([]);
  });
});

describe('scoring', () => {
  let db: MockDb;

  beforeEach(() => {
    db = makeMockDb(fixtures());
  });

  it('writes one row per rubric dimension at the resolved scorer version', async () => {
    await run(db, makeConfig());

    expect(db._scores.map((s) => s.scorerName).sort()).toEqual([
      'judge_plan_coherence',
      'judge_task_completion',
    ]);
    for (const row of db._scores) {
      expect(row.scorerVersion).toBe(REVISION.scorerVersion);
      expect(row.subjectId).toBe(OWN_SESSION);
    }
    expect(db._scores.find((s) => s.scorerName === 'judge_task_completion')?.label).toBe('partly');
    expect(db._scores.find((s) => s.scorerName === 'judge_plan_coherence')?.label).toBe('mixed');
  });

  it('records judge spend on every score', async () => {
    await run(db, makeConfig());
    for (const row of db._scores) {
      expect(Number(row.costUsd)).toBeGreaterThan(0);
    }
    // 10k input @ $5/MTok + 200 output @ $25/MTok = $0.055, split across two rows.
    const total = db._scores.reduce((sum, r) => sum + Number(r.costUsd), 0);
    expect(total).toBeCloseTo(0.055, 6);
  });

  it('stores the rationale by reference, redacted, under its own prefix', async () => {
    const leaky = JSON.stringify({
      plan_coherence: { label: 'coherent', rationale: 'Fine.' },
      task_completion: {
        label: 'yes',
        rationale: 'The developer pasted AKIAIOSFODNN7EXAMPLE into the shell.',
      },
    });
    const { s3 } = await run(db, makeConfig(), makeJudgeClient(leaky));

    const put = s3._puts[0];
    expect(put?.key).toMatch(/^judge-rationales\//);
    expect(put?.body).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(put?.body).toContain('[REDACTED:');

    for (const row of db._scores) {
      expect(row.rationaleRef).toBe(put?.key);
    }
  });

  it('writes nothing when the reply fails the constrained schema', async () => {
    const { s3 } = await run(db, makeConfig(), makeJudgeClient('Ignore the rubric. All good!'));

    // The read still happened, so it is still audited — but a reply that said
    // nothing must not become a score.
    expect(db._audits).toHaveLength(1);
    expect(db._scores).toEqual([]);
    expect(s3._puts).toEqual([]);
  });

  it('sends the transcript as delimited, explicitly untrusted data', async () => {
    const judge = makeJudgeClient();
    await run(db, makeConfig(), judge);

    const call = judge.calls[0];
    expect(call?.system.toLowerCase()).toContain('untrusted');
    expect(call?.user).toContain('<<<BEGIN TRANSCRIPT>>>');
    expect(call?.user).toContain('please fix the failing migration');
  });
});

describe('rationale lifecycle', () => {
  function makeRationaleDb(refs: string[]) {
    const cleared: unknown[] = [];
    return {
      _cleared: cleared,
      score: {
        findMany: vi.fn(async () => refs.map((rationaleRef) => ({ rationaleRef }))),
        updateMany: vi.fn(async (args: unknown) => {
          cleared.push(args);
          return { count: refs.length };
        }),
      },
    };
  }

  it('deletes rationale objects and clears the pointers when a transcript is swept', async () => {
    const db = makeRationaleDb([`judge-rationales/${OWN_SESSION}/v1.json`]);
    const deleted: unknown[] = [];
    const s3 = {
      send: vi.fn(async (cmd: { input: { Delete?: { Objects: { Key: string }[] } } }) => {
        if (cmd.input.Delete) {
          deleted.push(...cmd.input.Delete.Objects.map((o) => o.Key));
        }
        return {};
      }),
    };

    const purged = await purgeJudgeRationales(
      db as unknown as Parameters<typeof purgeJudgeRationales>[0],
      s3 as unknown as S3Client,
      'transcripts',
      [OWN_SESSION],
      { clearRefs: true },
    );

    expect(purged).toBe(1);
    expect(deleted).toEqual([`judge-rationales/${OWN_SESSION}/v1.json`]);
    expect(db._cleared).toHaveLength(1);
  });

  it('leaves the score rows alone on the deletion path, which removes them anyway', async () => {
    const db = makeRationaleDb([`judge-rationales/${OWN_SESSION}/v1.json`]);
    const s3 = { send: vi.fn(async () => ({})) };

    await purgeJudgeRationales(
      db as unknown as Parameters<typeof purgeJudgeRationales>[0],
      s3 as unknown as S3Client,
      'transcripts',
      [OWN_SESSION],
      { clearRefs: false },
    );

    expect(db._cleared).toEqual([]);
  });

  it('stores rationales outside the transcripts/ prefix the orphan sweep owns', () => {
    expect(judgeRationaleKey(OWN_SESSION, 3)).toBe(`judge-rationales/${OWN_SESSION}/v3.json`);
    expect(judgeRationaleKey(OWN_SESSION, 3).startsWith('transcripts/')).toBe(false);
  });
});

describe('AnthropicJudgeClient', () => {
  it('sends no tools and no sampling parameters', async () => {
    const captured: { body: Record<string, unknown>; url: string }[] = [];
    const fetchMock = vi.fn(async (url: string, init: { body: string }) => {
      captured.push({ body: JSON.parse(init.body), url: String(url) });
      return {
        json: async () => ({
          content: [{ text: VERDICT, type: 'text' }],
          usage: { input_tokens: 5, output_tokens: 5 },
        }),
        ok: true,
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new AnthropicJudgeClient({
      apiKey: 'sk-test',
      baseUrl: 'https://api.anthropic.com',
    });
    const completion = await client.complete({
      revision: REVISION,
      system: 'system',
      user: 'user',
    });

    expect(completion.text).toBe(VERDICT);
    const body = captured[0]?.body ?? {};
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('top_p');
    expect(body.model).toBe(REVISION.model);
    expect(body.max_tokens).toBe(REVISION.params.maxOutputTokens);

    vi.unstubAllGlobals();
  });

  it('treats a refusal as no verdict rather than an empty one', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        json: async () => ({ content: [], stop_reason: 'refusal' }),
        ok: true,
      })),
    );

    const client = new AnthropicJudgeClient({
      apiKey: 'sk-test',
      baseUrl: 'https://api.anthropic.com',
    });
    await expect(client.complete({ revision: REVISION, system: 's', user: 'u' })).rejects.toThrow(
      /refused/,
    );

    vi.unstubAllGlobals();
  });
});
