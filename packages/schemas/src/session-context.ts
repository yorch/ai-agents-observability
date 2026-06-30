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

export const SessionContextSchema = z.object({
  cwd: z.string(),
  git: GitContextSchema.nullable(),
  is_resume: z.boolean(),
  mode: z.enum(PERMISSION_MODES),
  project_name: z.string().nullable().optional(),
});

export type SessionContext = z.infer<typeof SessionContextSchema>;
