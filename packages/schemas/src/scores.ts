/**
 * The scoring substrate (P13-001).
 *
 * Every computed signal in the platform — heuristic, deterministic, human, or
 * judge — is a row in one `scores` table carrying *who* produced it and *at what
 * version*. Before this existed, scores were hard-wired columns on `sessions`
 * (`friction_score`, `shape_label`) with no scorer identity, no version, and no
 * room for a second scorer to disagree, which made calibration impossible and
 * re-scoring a bespoke backfill job every time.
 *
 * Field names are chosen *toward* the emerging OpenTelemetry GenAI evaluation
 * event so a future bridge is a mapping rather than a migration. They are
 * deliberately not pinned to it: as of July 2026 no GenAI span, event, metric,
 * or attribute in that spec is marked Stable.
 *
 * This module is the single source of scorer identity. Adding a scorer means
 * adding an entry to `SCORERS` — not passing a string literal at a call site.
 */

import { FRICTION_VERSION } from './effectiveness';
import { JUDGE_BASE_SCORER_VERSION } from './judge';
import { SESSION_RUBRIC_VERSION } from './rubric';

/** What a score is attached to. Matches the DB enum (UPPER_SNAKE_CASE). */
export type ScoreSubjectType = 'SESSION' | 'PULL_REQUEST' | 'SKILL' | 'MCP_SERVER';

/**
 * `subject_id` for a skill or MCP-server score.
 *
 * Skills and slash commands share a namespace on the wire (`skill_name` falls
 * back to `slash_command`), so the kind is part of the identity: `/review` the
 * slash command and `review` the skill are different subjects with different
 * owners. MCP servers need no prefix — the server name is already unique.
 */
export function skillSubjectId(kind: 'skill' | 'slash', name: string): string {
  return `${kind}:${name}`;
}

/**
 * Where a score came from. The distinction matters for calibration: a `HUMAN`
 * label is what `HEURISTIC` and `JUDGE` scorers get measured *against*, and an
 * `OUTCOME` is the objective fact neither of them can argue with.
 */
export type ScoreSource = 'HEURISTIC' | 'DETERMINISTIC' | 'HUMAN' | 'JUDGE' | 'OUTCOME';

/**
 * Numeric scorers write `value`; categorical scorers write `label`. Both columns
 * exist because calibration treats them differently — a confusion matrix for one,
 * a correlation for the other — and overloading a single column would force every
 * reader to know which kind it was dealing with.
 */
export type ScoreKind = 'NUMERIC' | 'CATEGORICAL';

export type ScorerDefinition = {
  /** Human-readable purpose; kept next to the definition so it stays true. */
  readonly description: string;
  readonly kind: ScoreKind;
  /**
   * Whether this scorer's subject persists, so a score is about a *window*
   * rather than about a thing that happened once (P13-013).
   *
   * A session is scored once and that score is true forever; a skill or an MCP
   * server is scored over a trailing window, and next week's figure is a new
   * row, not a correction of this week's. Declaring it here rather than leaving
   * each job to remember is what lets `buildScoreRow` reject the two mistakes
   * that would silently corrupt a series: a periodic scorer writing without a
   * period (every night overwrites the last, which is the bug this task exists
   * to fix), and a one-shot scorer writing *with* one (an invented window that
   * splits a session's single score into duplicates).
   */
  readonly periodic?: true;
  readonly source: ScoreSource;
  readonly subjectType: ScoreSubjectType;
  /**
   * Bump when the scorer's *meaning* changes (weights, thresholds, rubric
   * wording, judge prompt). A bump writes new rows rather than overwriting old
   * ones, so a trend can show the boundary instead of blending two scorers into
   * one misleading line.
   */
  readonly version: number;
};

/**
 * Session-shape classifier version. Independent of `FRICTION_VERSION` — the two
 * scorers move separately, and a single phase-wide version would force spurious
 * re-scores of one whenever the other changed.
 */
export const SESSION_SHAPE_VERSION = 1;

/**
 * Deterministic trajectory scorer versions (P13-003).
 *
 * One constant per scorer, deliberately. These six will move independently —
 * re-tuning the edit-thrash repeat threshold has nothing to do with the retry
 * weighting — and a single phase-wide version would re-score every session
 * whenever any one of them changed, blowing away the version boundary that makes
 * a trend readable.
 */
export const RETRY_LOOP_VERSION = 1;
export const EDIT_THRASH_VERSION = 1;
export const REDUNDANT_READ_VERSION = 1;
export const DENIAL_RETRY_SUCCESS_VERSION = 1;
export const TESTS_BEFORE_MERGE_VERSION = 1;
export const STEP_EFFICIENCY_VERSION = 1;

/**
 * Skill and MCP-server effectiveness scorer versions (P13-004). Separate from
 * the trajectory set: their subjects are org-level artifacts, not sessions, and
 * their windows and thresholds move for different reasons.
 */
export const SKILL_EFFECTIVENESS_VERSION = 1;
export const MCP_EFFECTIVENESS_VERSION = 1;

/**
 * The scorer registry. The keys are the `scorer_name` values written to the DB.
 *
 * The human rubric (P13-005) and the judge (P13-009) each add entries here.
 * Nothing writes a scorer name as a string literal at a call site — `ScoreInput`
 * types `scorerName` as `keyof typeof SCORERS`, so a typo is a compile error and
 * a version bump lands everywhere at once.
 */
export const SCORERS = {
  friction: {
    description: 'Composite session friction from denials, tool errors, interrupts, abandonment.',
    kind: 'NUMERIC',
    source: 'HEURISTIC',
    subjectType: 'SESSION',
    version: FRICTION_VERSION,
  },
  /**
   * The two human-rubric scorers (P13-005). Their version *is* the rubric
   * version, so a reworded question writes new rows instead of silently
   * redefining what the old ones meant — the same discipline every computed
   * scorer here gets, applied to the label they are calibrated against.
   */
  human_session_shape: {
    description:
      'Session shape as reported by its owner, answering the versioned rubric. Blinded from the session_shape classifier at capture time.',
    kind: 'CATEGORICAL',
    source: 'HUMAN',
    subjectType: 'SESSION',
    version: SESSION_RUBRIC_VERSION,
  },
  human_task_outcome: {
    description:
      'Whether the session accomplished what its owner wanted (yes / partly / no). Blinded from friction_score at capture time.',
    kind: 'CATEGORICAL',
    source: 'HUMAN',
    subjectType: 'SESSION',
    version: SESSION_RUBRIC_VERSION,
  },
  /**
   * The two judge scorers (P13-009). Their version is the one field here that
   * is **not** authoritative: a judge's identity is its (prompt version, model,
   * parameters) triple, which depends on deployment configuration, so the
   * runner resolves a `JUDGE_REVISIONS` entry and passes `scorerVersion`
   * explicitly on every row. The value below is the first registered revision —
   * a floor, so `SCORERS` never shows a version that never existed.
   */
  judge_plan_coherence: {
    description:
      'LLM-as-judge label for whether the session trajectory held together (coherent / mixed / incoherent / unclear). Owner-visible only; uncalibrated until P13-010.',
    kind: 'CATEGORICAL',
    source: 'JUDGE',
    subjectType: 'SESSION',
    version: JUDGE_BASE_SCORER_VERSION,
  },
  judge_task_completion: {
    description:
      'LLM-as-judge label for whether the session accomplished what was asked (yes / partly / no / unclear). Owner-visible only; uncalibrated until P13-010.',
    kind: 'CATEGORICAL',
    source: 'JUDGE',
    subjectType: 'SESSION',
    version: JUDGE_BASE_SCORER_VERSION,
  },
  mcp_effectiveness: {
    description:
      'MCP server health over a window: call error rate, association with session friction. Value is the error rate in [0, 1].',
    kind: 'NUMERIC',
    periodic: true,
    source: 'DETERMINISTIC',
    subjectType: 'MCP_SERVER',
    version: MCP_EFFECTIVENESS_VERSION,
  },
  session_shape: {
    description: 'Session shape classified from the tool histogram.',
    kind: 'CATEGORICAL',
    source: 'HEURISTIC',
    subjectType: 'SESSION',
    version: SESSION_SHAPE_VERSION,
  },
  skill_effectiveness: {
    description:
      'Skill/slash-command profile over a window: downstream tool-error rate, association with session friction and PR outcome. Value is the downstream tool-error rate in [0, 1].',
    kind: 'NUMERIC',
    periodic: true,
    source: 'DETERMINISTIC',
    subjectType: 'SKILL',
    version: SKILL_EFFECTIVENESS_VERSION,
  },
  trajectory_denial_retry_success: {
    description:
      'Count of calls denied, retried, and then succeeded — a permission-config smell, not a developer failing.',
    kind: 'NUMERIC',
    source: 'DETERMINISTIC',
    subjectType: 'SESSION',
    version: DENIAL_RETRY_SUCCESS_VERSION,
  },
  trajectory_edit_thrash: {
    description: 'Share of writes spent on targets written repeatedly in one session, in [0, 1].',
    kind: 'NUMERIC',
    source: 'DETERMINISTIC',
    subjectType: 'SESSION',
    version: EDIT_THRASH_VERSION,
  },
  trajectory_redundant_read: {
    description: 'Share of reads that re-read a target with no intervening write to it, in [0, 1].',
    kind: 'NUMERIC',
    source: 'DETERMINISTIC',
    subjectType: 'SESSION',
    version: REDUNDANT_READ_VERSION,
  },
  trajectory_retry_loop: {
    description:
      'Share of identifiable calls that repeated an earlier call, discounted when the outcome changed, in [0, 1].',
    kind: 'NUMERIC',
    source: 'DETERMINISTIC',
    subjectType: 'SESSION',
    version: RETRY_LOOP_VERSION,
  },
  trajectory_step_efficiency: {
    description:
      'Tool calls relative to the median of same-shape sessions. 1.0 is typical; the baseline is recorded in metadata.',
    kind: 'NUMERIC',
    source: 'DETERMINISTIC',
    subjectType: 'SESSION',
    version: STEP_EFFICIENCY_VERSION,
  },
  trajectory_tests_before_merge: {
    description:
      'Whether a session linked to a merged PR ran a test command (1) or did not (0). Written only for sessions with a merged linked PR.',
    kind: 'NUMERIC',
    source: 'DETERMINISTIC',
    subjectType: 'SESSION',
    version: TESTS_BEFORE_MERGE_VERSION,
  },
} as const satisfies Record<string, ScorerDefinition>;

export type ScorerName = keyof typeof SCORERS;

export const SCORER_NAMES = Object.keys(SCORERS) as ScorerName[];

/** A score row as written by a scorer. `id` and `createdAt` are DB-assigned. */
export type ScoreInput = {
  /** Judge/eval spend, so the platform's own eval cost shows up in its own dashboards. */
  costUsd?: number | null;
  label?: string | null;
  /** Free-form provenance (baseline used, model, sample size). Never raw content. */
  metadata?: Record<string, unknown>;
  /**
   * The window this score describes. Required for a `periodic` scorer, rejected
   * for every other one — see `buildScoreRow`.
   *
   * `periodStart` must be bucketed, not a raw `now()`. It is the row's identity:
   * two runs on the same night must produce the same `periodStart` or the upsert
   * becomes an append and one night grows a row per run.
   */
  period?: { end: Date; start: Date };
  /**
   * Pointer to a rationale artifact (e.g. an S3 key) — never inline text. Judge
   * rationales derive from redacted transcripts and inherit their sensitivity, so
   * they live under the same retention and deletion paths as the transcript.
   */
  rationaleRef?: string | null;
  scorerName: ScorerName;
  /**
   * Overrides the registry version for scorers whose identity is only knowable
   * at run time — today that is the judge alone, whose version is the
   * `(prompt version, model, parameters)` triple resolved from
   * `JUDGE_REVISIONS`. Every other scorer must leave this unset so a version
   * bump stays a one-line edit in this file rather than a call-site decision.
   */
  scorerVersion?: number;
  subjectId: string;
  value?: number | null;
};

/**
 * Resolves a scorer name to the full row shape, filling subject type, source, and
 * the *current* version from the registry. Call sites never spell these out, so a
 * version bump lands everywhere at once and cannot be half-applied.
 *
 * Throws on a period that contradicts the registry, in both directions. Neither
 * mistake would surface as a failure otherwise — a periodic scorer that forgets
 * its period writes one row and overwrites it forever (the trend silently never
 * accumulates), and a one-shot scorer that supplies one splits a session's single
 * score into a row per run. Both produce a plausible-looking table.
 */
export function buildScoreRow(input: ScoreInput): {
  costUsd: number | null;
  label: string | null;
  metadata: Record<string, unknown>;
  periodEnd: Date | null;
  periodStart: Date | null;
  rationaleRef: string | null;
  scorerName: ScorerName;
  scorerVersion: number;
  source: ScoreSource;
  subjectId: string;
  subjectType: ScoreSubjectType;
  value: number | null;
} {
  const def: ScorerDefinition = SCORERS[input.scorerName];
  if (def.periodic && !input.period) {
    throw new Error(
      `Scorer "${input.scorerName}" is periodic and needs a period: without one every run overwrites the last and no trend ever accumulates.`,
    );
  }
  if (!def.periodic && input.period) {
    throw new Error(
      `Scorer "${input.scorerName}" is not periodic: its subject is scored once, so a period would split one score into a row per run.`,
    );
  }
  return {
    costUsd: input.costUsd ?? null,
    label: input.label ?? null,
    metadata: input.metadata ?? {},
    periodEnd: input.period?.end ?? null,
    periodStart: input.period?.start ?? null,
    rationaleRef: input.rationaleRef ?? null,
    scorerName: input.scorerName,
    scorerVersion: input.scorerVersion ?? def.version,
    source: def.source,
    subjectId: input.subjectId,
    subjectType: def.subjectType,
    value: input.value ?? null,
  };
}

/**
 * The bucketed window a nightly periodic scorer should write.
 *
 * Day-truncated on purpose. The job describes "the trailing N days as of now",
 * and `now()` differs by minutes between runs — so an unbucketed period would
 * give every re-run its own row and turn the idempotent upsert into an append.
 * Truncating to the day makes the row's identity the *date it describes*, which
 * is what a reader means by a point on a trend line.
 */
export function trailingWindow(windowDays: number, asOf: Date): { end: Date; start: Date } {
  const end = new Date(
    Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate(), 0, 0, 0, 0),
  );
  const start = new Date(end.getTime() - windowDays * 86_400_000);
  return { end, start };
}

/**
 * True when a score carries no information — a numeric scorer with no value or a
 * categorical one with no label. Scorers legitimately return null below a
 * minimum-volume threshold (`computeFrictionScore` does), and writing an empty row
 * would misrepresent "not enough data" as "scored".
 */
export function isEmptyScore(input: ScoreInput): boolean {
  const def = SCORERS[input.scorerName];
  return def.kind === 'NUMERIC'
    ? input.value === null || input.value === undefined
    : input.label === null || input.label === undefined || input.label === '';
}
