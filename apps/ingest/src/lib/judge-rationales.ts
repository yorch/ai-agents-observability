import type { PrismaClient } from '@ai-agents-observability/db';
import { redact } from '@ai-agents-observability/redaction';
import { SCORER_NAMES, SCORERS } from '@ai-agents-observability/schemas';
import { DeleteObjectsCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { Logger } from 'pino';

/**
 * Judge rationale artifacts (P13-009).
 *
 * A rationale is derived content: the judge wrote it after reading a redacted
 * transcript, and it inherits that transcript's sensitivity. So it is stored
 * **by reference** — an S3 object, pointed at by `scores.rationale_ref` — rather
 * than inline in a JSONB column, and it travels the same three paths the
 * transcript does:
 *
 *  - **redaction** — the text is run through `packages/redaction` before the
 *    write, on the same principle as the second server-side transcript pass:
 *    the judge is not trusted to have kept quotes clean.
 *  - **retention** — purged when the transcript it derives from is swept
 *    (`sweep-retention`), because a rationale outliving its source is a copy of
 *    the source that escaped the policy.
 *  - **deletion** — purged on a GDPR deletion (`run-deletions`), before the
 *    score rows that reference it are removed.
 *
 * The prefix is *not* `transcripts/`: `sweep-retention`'s orphan sweep deletes
 * anything under that prefix it cannot match to a session's transcript key, and
 * rationales would look exactly like orphans to it.
 */

export const JUDGE_RATIONALE_PREFIX = 'judge-rationales/';

/**
 * Scorer names whose rows carry a rationale artifact — every judge scorer,
 * derived from the registry rather than restated. A hand-written copy of this
 * list is a second source of truth that only agrees with `SCORERS` until someone
 * registers a third judge scorer; here that would mean its rationale objects
 * silently surviving both the retention sweep and a GDPR deletion.
 */
const JUDGE_SCORER_NAMES: string[] = SCORER_NAMES.filter(
  (name) => SCORERS[name].source === 'JUDGE',
);

/**
 * One artifact per (session, scorer version): both dimensions of a single
 * verdict share it, so a version bump writes a new object beside the old one
 * rather than overwriting the rationale a prior version's rows still point at.
 */
export function judgeRationaleKey(sessionId: string, scorerVersion: number): string {
  return `${JUDGE_RATIONALE_PREFIX}${sessionId}/v${scorerVersion}.json`;
}

export type JudgeRationaleArtifact = {
  createdAt: string;
  judgeModel: string;
  judgePromptVersion: number;
  planCoherence: { label: string; rationale: string };
  scorerVersion: number;
  sessionId: string;
  taskCompletion: { label: string; rationale: string };
};

/**
 * Writes a rationale artifact, redacting both rationales first. Returns the key
 * and the redaction classes that fired, which the caller records on the score
 * metadata so a reader can tell a scrubbed rationale from a clean one.
 */
export async function putJudgeRationale(
  s3: S3Client,
  bucket: string,
  artifact: JudgeRationaleArtifact,
): Promise<{ key: string; redactionFlags: string[] }> {
  const completion = redact(artifact.taskCompletion.rationale);
  const coherence = redact(artifact.planCoherence.rationale);

  const body: JudgeRationaleArtifact = {
    ...artifact,
    planCoherence: { ...artifact.planCoherence, rationale: coherence.text },
    taskCompletion: { ...artifact.taskCompletion, rationale: completion.text },
  };

  const key = judgeRationaleKey(artifact.sessionId, artifact.scorerVersion);
  await s3.send(
    new PutObjectCommand({
      Body: JSON.stringify(body),
      Bucket: bucket,
      ContentType: 'application/json',
      Key: key,
    }),
  );

  return { key, redactionFlags: [...new Set([...completion.flags, ...coherence.flags])] };
}

type RationaleDb = Pick<PrismaClient, 'score'>;

const CHUNK_SIZE = 1000;

/**
 * Deletes the rationale artifacts belonging to the given sessions and clears
 * the pointers that referenced them.
 *
 * `clearRefs` exists because the two callers want different endings: the
 * retention sweep keeps the score row (the label is metadata about a session
 * that still exists) and must null its dangling ref, while the deletion runner
 * is about to delete the row entirely and would only be writing to a corpse.
 */
export async function purgeJudgeRationales(
  db: RationaleDb,
  s3: S3Client,
  bucket: string,
  sessionIds: string[],
  options: { clearRefs: boolean },
  logger?: Logger,
): Promise<number> {
  if (sessionIds.length === 0) {
    return 0;
  }

  let purged = 0;
  for (let i = 0; i < sessionIds.length; i += CHUNK_SIZE) {
    const chunk = sessionIds.slice(i, i + CHUNK_SIZE);
    const rows = await db.score.findMany({
      select: { rationaleRef: true },
      where: {
        rationaleRef: { not: null },
        scorerName: { in: JUDGE_SCORER_NAMES },
        subjectId: { in: chunk },
        subjectType: 'SESSION',
      },
    });

    const keys = [
      ...new Set(rows.map((r) => r.rationaleRef).filter((k): k is string => k !== null)),
    ];
    if (keys.length === 0) {
      continue;
    }

    await s3
      .send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: keys.map((Key) => ({ Key })) },
        }),
      )
      .then(() => {
        purged += keys.length;
      })
      .catch((err) => {
        logger?.warn({ count: keys.length, err }, 'Failed to delete judge rationales (continuing)');
      });

    if (options.clearRefs) {
      await db.score.updateMany({
        data: { rationaleRef: null },
        where: {
          scorerName: { in: JUDGE_SCORER_NAMES },
          subjectId: { in: chunk },
          subjectType: 'SESSION',
        },
      });
    }
  }

  return purged;
}
