import { z } from 'zod';

export const GitContextSchema = z.object({
  branch: z.string().nullable(),
  commit: z.string().nullable(),
  github_login: z.string().nullable().optional(),
  is_dirty: z.boolean(),
  owner: z.string().nullable(),
  // Snapshot of CI and review state at the time the flusher processed the batch.
  // Optional so events predating this field continue to validate.
  pr_ci_status: z.enum(['SUCCESS', 'FAILURE', 'PENDING']).nullable().optional(),
  pr_number: z.number().int().nullable(),
  pr_review_decision: z
    .enum(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED'])
    .nullable()
    .optional(),
  remote_url: z.string().nullable(),
  repo: z.string().nullable(),
  team: z.string().nullable().optional(),
});

export type GitContext = z.infer<typeof GitContextSchema>;

// Canonical permission/autonomy modes (snake_case, the project enum convention).
// This is the single most important Human-in-the-Loop dimension: it records how
// much autonomy the human granted the agent for a given event. Claude Code emits
// its own casing in the hook payload's `permission_mode` field; map raw values
// through `canonicalPermissionMode` before they reach the wire schema.
//
// `normal` is the canonical "ask before acting" default (Claude Code's `default`)
// and the fallback when no mode is reported, so events predating mode capture and
// agents without a permission concept continue to validate.
export const PERMISSION_MODES = [
  'normal', // default: prompt before edits/commands
  'plan', // read-only research, no writes (most supervised)
  'accept_edits', // auto-accept file edits, still prompt for riskier ops
  'auto', // classifier-vetted auto-approval
  'dont_ask', // suppress prompts
  'bypass', // bypass all permission checks (least supervised)
] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];

// Autonomy ranking, supervised → autonomous. Used to pick a representative
// "max autonomy granted" mode for a session and to chart the autonomy mix.
// Higher number = less human oversight.
export const AUTONOMY_RANK: Record<PermissionMode, number> = {
  accept_edits: 2,
  auto: 3,
  bypass: 5,
  dont_ask: 4,
  normal: 1,
  plan: 0,
};

// Modes with effectively no per-action human gate: the agent acts without
// stopping for approval. Used to detect oversight-erosion (R9 autonomy_surge).
// `auto` is excluded — it still routes risky actions through a classifier.
export const LOW_OVERSIGHT_MODES: readonly PermissionMode[] = ['bypass', 'dont_ask'];

export function isLowOversightMode(mode: string | null | undefined): boolean {
  return mode != null && (LOW_OVERSIGHT_MODES as readonly string[]).includes(mode);
}

// Maps an agent's raw permission-mode string (e.g. Claude Code's
// `default`/`acceptEdits`/`bypassPermissions`) to the canonical enum. Unknown or
// absent values fall back to `normal` so capture never rejects a payload.
export function canonicalPermissionMode(raw: unknown): PermissionMode {
  if (typeof raw !== 'string') {
    return 'normal';
  }
  switch (raw) {
    case 'default':
    case 'normal':
      return 'normal';
    case 'plan':
      return 'plan';
    case 'acceptEdits':
    case 'accept_edits':
      return 'accept_edits';
    case 'auto':
      return 'auto';
    case 'dontAsk':
    case 'dont_ask':
      return 'dont_ask';
    case 'bypassPermissions':
    case 'bypass':
      return 'bypass';
    default:
      return 'normal';
  }
}

// How a session was produced (P13-002). `interactive` is a developer at a
// keyboard; `ci` is an agent run inside a pipeline; `eval` is a run from an
// external eval harness (see tasks/P13-002 — this platform stores such runs but
// deliberately does not execute them).
//
// Optional on the wire and defaulting to `interactive`, so every already-shipped
// hook binary keeps working unchanged with no schema version bump. Only an
// explicit claim moves a run out of the human aggregates — and since nothing is
// granted by the claim, a client that lies only removes its own data.
export const RUN_KINDS = ['interactive', 'ci', 'eval'] as const;

export type RunKind = (typeof RUN_KINDS)[number];

export const DEFAULT_RUN_KIND: RunKind = 'interactive';

/** DB enum spelling of `RunKind` (UPPER_SNAKE_CASE, per packages/db/AGENTS.md). */
export type RunKindDb = 'INTERACTIVE' | 'CI' | 'EVAL';

/** Wire (lowercase) → DB enum (UPPER_SNAKE_CASE, per packages/db/AGENTS.md). */
export function runKindToDbEnum(kind: RunKind | null | undefined): RunKindDb {
  switch (kind) {
    case 'ci':
      return 'CI';
    case 'eval':
      return 'EVAL';
    default:
      return 'INTERACTIVE';
  }
}

/**
 * How a session's `run_kind` combines across the events and batches that build it.
 *
 * **Rule: the first explicit non-interactive claim wins, and it is sticky.**
 *
 * The rule is asymmetric because the two values are not equally informative.
 * `run_kind` is optional on the wire and absent means `interactive`, so an
 * INTERACTIVE reading is ambiguous — it is either an explicit claim or merely the
 * default standing in for a field nobody sent. CI and EVAL are never defaults;
 * they only ever arrive because a client said so. Treating the two symmetrically
 * (last-write-wins, or first-write-wins) would let a single event that omitted the
 * field overwrite a real claim, or pin a session INTERACTIVE forever because its
 * first batch happened to predate the environment detection.
 *
 * Sticky in the other direction matters just as much: once a session is known to
 * be a CI run, a later defaulted INTERACTIVE event must not promote it back into
 * the human aggregates. And since a claim only ever *removes* a run from those
 * aggregates, honouring it eagerly cannot be used to smuggle data in.
 *
 * CI vs EVAL between themselves is first-claim-wins, which is arbitrary but
 * deterministic — a session is not expected to be both.
 */
export function mergeRunKind(current: RunKindDb, incoming: RunKindDb): RunKindDb {
  return current === 'INTERACTIVE' ? incoming : current;
}

export const SessionContextSchema = z.object({
  cwd: z.string(),
  git: GitContextSchema.nullable(),
  is_resume: z.boolean(),
  mode: z.enum(PERMISSION_MODES),
  project_name: z.string().nullable().optional(),
  run_kind: z.enum(RUN_KINDS).optional(),
});

export type SessionContext = z.infer<typeof SessionContextSchema>;
