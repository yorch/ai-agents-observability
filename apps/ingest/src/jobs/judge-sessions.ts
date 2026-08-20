import type { PrismaClient } from '@ai-agents-observability/db';
import { AuditAction, Prisma } from '@ai-agents-observability/db';
import {
  buildJudgeUserMessage,
  excerptTranscript,
  type JudgeRevision,
  type JudgeTranscriptMessage,
  judgeCostUsd,
  judgeScoreMetadata,
  judgeSystemPrompt,
  parseJudgeVerdict,
  type ScoreInput,
} from '@ai-agents-observability/schemas';
import type { S3Client } from '@aws-sdk/client-s3';
import type { Logger } from 'pino';

import type { JudgeModelClient } from '../lib/judge-client';
import { putJudgeRationale } from '../lib/judge-rationales';
import { scoreUpserts } from '../lib/scores';
import { downloadAndParseTranscript, extractTextContent } from './index-transcripts';
import { type JobRawDb, withJobRun } from './job-run';

/**
 * The LLM-as-judge runner (P13-009).
 *
 * A judge is a new privileged reader of developers' conversations in a platform
 * whose political premise is that transcripts are private by default. So the
 * guardrails are the feature, not the follow-up:
 *
 * **Two independent guards, both evaluated twice.**
 *   1. *Consent* — the session's owner has set `allow_judge_analysis` on their
 *      `VisibilityPolicy`. Nothing else implies it; sharing transcripts with the
 *      org does not.
 *   2. *Own sessions only* — the session belongs to the operator running the
 *      job ({@link JUDGE_OWN_SESSIONS_ONLY}). This one is a **code constant, not
 *      an environment variable**, on purpose: no deployment configuration can
 *      point this runner at another person's transcript. Removing it is
 *      P13-011, a separate task with a separate decision, and the tests here
 *      assert that removing *either* guard alone still blocks a third party.
 *
 * Both run at candidate selection (in SQL, so an ineligible session is never
 * even listed) and again immediately before the fetch, so consent revoked
 * between the two blocks the read.
 *
 * **Every read is audited.** An `AuditLog` row lands in the subject's own feed
 * before the object is fetched — a failed audit write means no read.
 *
 * **The judge gets no tools** ({@link JudgeModelClient} cannot send any) and its
 * reply is parsed against a closed schema. Transcripts are untrusted input.
 *
 * Nothing here touches the hook or the ingest request path, and nothing outside
 * the owner's own session page reads what it writes.
 */

/**
 * Guard 2. Deliberately a constant rather than config: the acceptance criteria
 * for P13-011 begin "the own-sessions config guard is removed", which must be a
 * reviewed code change, not a value an operator can set at 3am.
 */
export const JUDGE_OWN_SESSIONS_ONLY = true;

const JOB_NAME = 'judge-sessions';

/** Only sessions with recent activity are candidates; older ones age out. */
const CANDIDATE_WINDOW_DAYS = 30;

/** Resolution of the deterministic sampler. 4 decimal places is ample. */
const SAMPLE_BUCKETS = 10_000;

/** CI states that count as outcome-negative. */
const FAILED_CI_STATES = ['failure', 'failed', 'error'];

export type JudgeRunConfig = {
  highCostUsd: number;
  maxSessionsPerRun: number;
  /** The one user whose sessions may be judged (and the audit actor). */
  operatorUserId: string;
  /**
   * Guard 2, injectable **for tests only** so the suite can prove each guard
   * blocks on its own. Production callers leave it unset and get the constant.
   */
  ownSessionsOnly?: boolean;
  revision: JudgeRevision;
  sampleRate: number;
};

type JudgeDb = JobRawDb & Pick<PrismaClient, 'auditLog'>;

type CandidateRow = {
  agent_type: string;
  session_id: string;
  transcript_s3_key: string;
};

type GuardRow = {
  allow_judge_analysis: boolean;
  user_id: string;
};

function ownSessionsOnly(config: JudgeRunConfig): boolean {
  return config.ownSessionsOnly ?? JUDGE_OWN_SESSIONS_ONLY;
}

/**
 * Candidate selection — guards first, sampling second.
 *
 * The guards are in the `WHERE` clause rather than applied in TypeScript after
 * the fact, so a session outside the permitted set is never listed, never
 * fetched, never decompressed, and never sent to a model.
 *
 * Sampling is deterministic (`hashtext` of the session id) rather than random,
 * so a re-run judges the same sessions instead of drifting into a wider and
 * wider sample of the corpus with each pass. Outcome-negative sessions — a
 * reverted PR, a failed CI status, an abandoned run that already cost real
 * money — bypass the sampler entirely: they are the population a 10% sample is
 * most likely to miss and the one most worth reading.
 */
export async function selectJudgeCandidates(
  db: Pick<JudgeDb, '$queryRaw'>,
  config: JudgeRunConfig,
): Promise<CandidateRow[]> {
  const sampleCutoff = Math.round(Math.min(Math.max(config.sampleRate, 0), 1) * SAMPLE_BUCKETS);

  // GUARD 2 (own sessions only). `Prisma.sql` fragments only — no identifier or
  // predicate is ever built by string concatenation.
  const ownerFilter = ownSessionsOnly(config)
    ? Prisma.sql`s.user_id = ${config.operatorUserId}::uuid`
    : Prisma.sql`TRUE`;

  return db.$queryRaw<CandidateRow[]>(Prisma.sql`
    SELECT s.session_id::text AS session_id, s.agent_type, s.transcript_s3_key
    FROM interactive_sessions s
    JOIN visibility_policies vp ON vp.user_id = s.user_id
    WHERE s.transcript_s3_key IS NOT NULL
      AND s.status <> 'ACTIVE'
      AND s.last_event_at >= NOW() - (${CANDIDATE_WINDOW_DAYS} * INTERVAL '1 day')
      -- GUARD 1: explicit per-user consent for judge analysis.
      AND vp.allow_judge_analysis = TRUE
      -- GUARD 2: the operator's own sessions.
      AND ${ownerFilter}
      -- Idempotency: already judged at this exact scorer version.
      AND NOT EXISTS (
        SELECT 1 FROM scores sc
        WHERE sc.subject_type = 'SESSION'
          AND sc.subject_id = s.session_id::text
          AND sc.scorer_name = 'judge_task_completion'
          AND sc.scorer_version = ${config.revision.scorerVersion}
      )
      AND (
        -- Outcome-negative sessions are always included.
        EXISTS (
          SELECT 1 FROM session_pr_links l
          JOIN pull_requests pr ON pr.repo_id = l.repo_id AND pr.pr_number = l.pr_number
          WHERE l.session_id = s.session_id AND pr.reverted_at IS NOT NULL
        )
        OR s.pr_ci_status = ANY(${FAILED_CI_STATES}::text[])
        OR (s.status = 'ABANDONED' AND s.total_cost_usd >= ${config.highCostUsd})
        -- Otherwise: deterministic low-rate sample. The bigint cast is load
        -- bearing: hashtext returns int4, and abs(-2147483648) overflows.
        OR (abs(hashtext(s.session_id::text)::bigint) % ${SAMPLE_BUCKETS}) < ${sampleCutoff}
      )
    ORDER BY s.last_event_at DESC
    LIMIT ${config.maxSessionsPerRun}
  `);
}

/**
 * Re-evaluates both guards immediately before the fetch.
 *
 * This is not belt-and-braces around the same query: selection and fetch are
 * separated in time (a batch is listed, then worked through one session at a
 * time), and a developer who revokes consent in that window must not have the
 * session they just withdrew read anyway.
 *
 * Returns the owner id when the read is permitted, `null` when it is not.
 */
export async function resolveJudgeSubject(
  db: Pick<JudgeDb, '$queryRaw'>,
  sessionId: string,
  config: JudgeRunConfig,
): Promise<string | null> {
  // run-kind-exempt: this looks up one already-identified session by its exact
  // session_id. The candidate was already restricted to `interactive_sessions`
  // in selectJudgeCandidates above, so run kind is not a population filter
  // here — this is a re-check of *consent* for a session already known to be
  // eligible, and consent is the thing that must not be assumed from the
  // earlier query. Filtering by run kind again would be redundant rather than
  // unsafe (it would fail closed, returning no row and skipping the session);
  // it is left out because the guard this lookup exists to enforce is
  // `allow_judge_analysis`, and mixing a second predicate into it would blur
  // which condition rejected a session.
  const rows = await db.$queryRaw<GuardRow[]>(Prisma.sql`
    SELECT s.user_id::text AS user_id,
           COALESCE(vp.allow_judge_analysis, FALSE) AS allow_judge_analysis
    -- run-kind-exempt: one session by primary key, already selected via
    -- interactive_sessions upstream; see the comment above this function.
    FROM sessions s
    LEFT JOIN visibility_policies vp ON vp.user_id = s.user_id
    WHERE s.session_id = ${sessionId}::uuid
  `);

  const row = rows[0];
  if (!row) {
    return null;
  }
  // GUARD 1, again: consent as of *now*, not as of selection.
  if (row.allow_judge_analysis !== true) {
    return null;
  }
  // GUARD 2, again.
  if (ownSessionsOnly(config) && row.user_id !== config.operatorUserId) {
    return null;
  }
  return row.user_id;
}

/**
 * Judges one session. Returns true when score rows were written.
 *
 * Order matters and is the whole point: guards → audit → fetch. A read that the
 * subject cannot see in their audit feed is the thing this job must never do,
 * so a failed audit write aborts the session rather than proceeding unlogged.
 */
export async function judgeOneSession(
  db: JudgeDb,
  s3: S3Client,
  bucket: string,
  candidate: CandidateRow,
  config: JudgeRunConfig,
  client: JudgeModelClient,
  logger?: Logger,
): Promise<boolean> {
  const { revision } = config;

  const ownerUserId = await resolveJudgeSubject(db, candidate.session_id, config);
  if (ownerUserId === null) {
    logger?.info(
      { jobName: JOB_NAME, sessionId: candidate.session_id },
      'judge: session no longer eligible at fetch time, skipping',
    );
    return false;
  }

  try {
    await db.auditLog.create({
      data: {
        action: AuditAction.JUDGE_READ_TRANSCRIPT,
        actorUserId: config.operatorUserId,
        justification: `Automated evaluation: ${revision.model} judge, scorer version ${revision.scorerVersion}`,
        targetSessionId: candidate.session_id,
        targetUserId: ownerUserId,
      },
    });
  } catch (err) {
    logger?.error(
      { err, jobName: JOB_NAME, sessionId: candidate.session_id },
      'judge: audit write failed, refusing to read transcript',
    );
    return false;
  }

  const parsedMessages = await downloadAndParseTranscript(
    s3,
    bucket,
    candidate.transcript_s3_key,
    logger,
  );
  if (parsedMessages === null) {
    return false;
  }

  const messages: JudgeTranscriptMessage[] = parsedMessages.map((m) => ({
    role: typeof m.role === 'string' ? m.role : 'unknown',
    text: extractTextContent(m.content),
  }));
  const excerpt = excerptTranscript(messages);
  if (excerpt.trim().length === 0) {
    logger?.info(
      { jobName: JOB_NAME, sessionId: candidate.session_id },
      'judge: transcript has no readable content, skipping',
    );
    return false;
  }

  const completion = await client.complete({
    revision,
    system: judgeSystemPrompt(revision),
    user: buildJudgeUserMessage(candidate.agent_type, excerpt),
  });

  const verdict = parseJudgeVerdict(completion.text);
  if (verdict === null) {
    // A reply that failed the closed schema said nothing. Writing a row for it
    // would turn "the judge misbehaved" into "the session scored".
    logger?.warn(
      { jobName: JOB_NAME, sessionId: candidate.session_id },
      'judge: reply did not match the verdict schema, no score written',
    );
    return false;
  }

  const { key: rationaleRef, redactionFlags } = await putJudgeRationale(s3, bucket, {
    createdAt: new Date().toISOString(),
    judgeModel: revision.model,
    judgePromptVersion: revision.promptVersion,
    planCoherence: verdict.plan_coherence,
    scorerVersion: revision.scorerVersion,
    sessionId: candidate.session_id,
    taskCompletion: verdict.task_completion,
  });

  // One model call produced both labels, so its cost is split evenly across the
  // two rows: a cost view that sums `scores.cost_usd` then reports the true
  // judge spend rather than double-counting it.
  const perScoreCost = judgeCostUsd(revision, completion.usage) / 2;
  const metadata = {
    ...judgeScoreMetadata(revision),
    rationaleRedactionFlags: redactionFlags,
  };

  const inputs: ScoreInput[] = [
    {
      costUsd: perScoreCost,
      label: verdict.task_completion.label,
      metadata,
      rationaleRef,
      scorerName: 'judge_task_completion',
      scorerVersion: revision.scorerVersion,
      subjectId: candidate.session_id,
    },
    {
      costUsd: perScoreCost,
      label: verdict.plan_coherence.label,
      metadata,
      rationaleRef,
      scorerName: 'judge_plan_coherence',
      scorerVersion: revision.scorerVersion,
      subjectId: candidate.session_id,
    },
  ];

  const statements = scoreUpserts(inputs);
  await db.$transaction(statements.map((sql) => db.$executeRaw(sql)));
  return true;
}

/**
 * Nightly (when enabled): judge a sampled stream of the operator's consented
 * sessions. Off by default on a fresh deployment, and a no-op unless both the
 * judge API key and the operator user id are configured.
 */
export async function runJudgeSessions(
  db: JudgeDb,
  s3: S3Client,
  bucket: string,
  config: JudgeRunConfig,
  client: JudgeModelClient,
  logger?: Logger,
): Promise<void> {
  await withJobRun(db, JOB_NAME, logger, async () => {
    const candidates = await selectJudgeCandidates(db, config);

    let scored = 0;
    for (const candidate of candidates) {
      try {
        if (await judgeOneSession(db, s3, bucket, candidate, config, client, logger)) {
          scored++;
        }
      } catch (err) {
        // One bad session (a provider error, a corrupt object) must not abort
        // the pass — the rest of the batch is still worth judging.
        logger?.warn(
          { err, jobName: JOB_NAME, sessionId: candidate.session_id },
          'judge: failed to score session',
        );
      }
    }

    logger?.info(
      {
        candidates: candidates.length,
        jobName: JOB_NAME,
        model: config.revision.model,
        scored,
        scorerVersion: config.revision.scorerVersion,
      },
      'Judge pass complete',
    );
  });
}
