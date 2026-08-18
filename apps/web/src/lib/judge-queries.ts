import { SCORER_NAMES, SCORERS } from '@ai-agents-observability/schemas';

import { readScores } from './scores';

/**
 * Reads of judge output (P13-009) — **owner-scoped, and only that**.
 *
 * Judge labels are a machine's quality judgement about one person's work, in a
 * product whose stated rule is that every new analysis surface must first answer
 * "what does the individual developer get from this?". Until P13-010 has
 * calibrated the judge and P13-011 has taken the exposure decision with
 * developers consulted, the answer is: the person whose session it is sees it,
 * and nobody else does.
 *
 * That is enforced three ways, in decreasing order of strength:
 *
 *  1. **The read path refuses.** Every query here goes through `readScores` in
 *     `lib/scores.ts`, which returns a judge row's `label`/`rationale_ref` only
 *     against an owner id it verifies itself, and hands every other caller a
 *     row type with no label on it. A future surface cannot get a verdict out
 *     of the database without proving whose it is.
 *  2. **The scorer set is derived, not listed.** `JUDGE_SCORER_NAMES` comes
 *     from the registry's own `source` field, so a third judge scorer is
 *     covered by this read the day it is registered — the previous hand-written
 *     pair would have silently dropped it from the owner's own page.
 *  3. **A source lint**, `test/judge-owner-only.test.ts`, still asserts that no
 *     module outside `/me` so much as names a judge scorer. That one is a lint
 *     rather than a proof (a `source: 'JUDGE'` query walks straight past it),
 *     which is exactly why (1) exists.
 */

/**
 * The judge scorers, derived from the registry rather than restated. `SCORERS`
 * is the single source of scorer identity; a literal list here is a second one
 * that only agrees with it until someone adds a scorer.
 */
export const JUDGE_SCORER_NAMES = SCORER_NAMES.filter((name) => SCORERS[name].source === 'JUDGE');

export type JudgeScoreRow = {
  costUsd: number | null;
  createdAt: Date;
  label: string;
  model: string | null;
  promptVersion: number | null;
  scorerName: string;
  scorerVersion: number;
};

function readMetadataString(metadata: unknown, key: string): string | null {
  if (typeof metadata !== 'object' || metadata === null) {
    return null;
  }
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

function readMetadataNumber(metadata: unknown, key: string): number | null {
  if (typeof metadata !== 'object' || metadata === null) {
    return null;
  }
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === 'number' ? value : null;
}

/**
 * Judge scores for one session, newest scorer version first. Returns `[]` when
 * the session is not owned by `userId` — the ownership check is performed by
 * `readScores`, not asserted by this caller.
 */
export async function getSessionJudgeScores(
  userId: string,
  sessionId: string,
): Promise<JudgeScoreRow[]> {
  const rows = await readScores(
    {
      scorerNames: JUDGE_SCORER_NAMES,
      subjectIds: [sessionId],
      subjectType: 'SESSION',
    },
    { kind: 'owner', ownerUserId: userId },
  );

  return rows
    .filter((r) => r.label !== null)
    .map((r) => ({
      costUsd: r.costUsd,
      createdAt: r.createdAt,
      label: r.label as string,
      model: readMetadataString(r.metadata, 'judgeModel'),
      promptVersion: readMetadataNumber(r.metadata, 'judgePromptVersion'),
      scorerName: r.scorerName,
      scorerVersion: r.scorerVersion,
    }));
}

/**
 * Total judge spend over a window — **aggregate money, never a label**.
 *
 * This is the one judge read that is not owner-scoped, and the distinction is
 * the point: a cost-observability product that cannot show its own eval bill has
 * no standing to show anyone else's. It selects on `source: 'JUDGE'` rather than
 * on the scorer names precisely so it cannot grow into a label read — and it
 * asks `readScores` for the `aggregate-only` view, whose row type has no `label`
 * and no `rationaleRef`, so that intent is enforced by the compiler rather than
 * by this paragraph. It returns two numbers with no subject attached: no session
 * id, no user, no verdict. Rendered on `/admin/jobs`, beside the switch that
 * turns the spending on.
 */
export async function getJudgeSpend(sinceDays = 30): Promise<{
  costUsd: number;
  scoredSessions: number;
}> {
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);

  const rows = await readScores(
    { since, source: 'JUDGE' },
    {
      kind: 'aggregate-only',
      reason: 'Admin-visible eval spend: money and a distinct-subject count, no verdicts.',
    },
  );

  return {
    costUsd: rows.reduce((sum, r) => sum + (r.costUsd ?? 0), 0),
    scoredSessions: new Set(rows.map((r) => r.subjectId)).size,
  };
}
