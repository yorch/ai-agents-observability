/**
 * Deterministic trajectory scorers (P13-003).
 *
 * Six content-free measurements over the ordered event list of a single session.
 * Every input is already in the events hypertable; none of them reads a
 * transcript, an S3 object, or any tool input or output. They cost nothing per
 * run and carry no privacy surface, which is why the 2026 agent-eval consensus
 * puts this layer *below* any judge: measure what code can measure, and spend
 * tokens only on what it cannot.
 *
 * Three properties hold for every scorer here and are the point of the module:
 *
 * 1. **Pure.** Ordered events in, number out. No clock, no database, no I/O.
 *    That makes them testable against fixtures and identical in ingest and web.
 * 2. **Null below a minimum volume.** A four-event session cannot be
 *    characterized, and a scorer that answers anyway produces a number that
 *    reads as a verdict. `computeFrictionScore` set this precedent; these follow
 *    it. `isEmptyScore` then keeps the empty row out of the `scores` table
 *    entirely, so "not enough data" never renders as "scored 0".
 * 3. **Agent-neutral.** Tool *roles* are resolved through `toolRole`, which
 *    branches on `agent_type` only where the semantics genuinely differ
 *    (codex's `apply_patch` is a write; opencode's `bash` is an exec). No scorer
 *    name, threshold, or returned label mentions a specific agent.
 *
 * Each scorer carries its own version constant in `scores.ts`. They will move
 * independently and a single phase-wide version would force spurious re-scores.
 */

import { EXEC_TOOLS, READ_TOOLS, WRITE_TOOLS } from './effectiveness';

/**
 * The projection of an event this module needs. A deliberately narrow shape:
 * anything wider would tempt a scorer into reading content.
 *
 * Callers pass events **already ordered** by `(ts, event_id)`. Ordering is the
 * caller's job because the database can do it for free and re-sorting a large
 * batch in JS cannot.
 */
export type TrajectoryEvent = {
  /** DB enum casing (`CLAUDE_CODE`, `OPENCODE`, `CODEX`, …). */
  agentType: string;
  eventType: string;
  /** Coarse shell-command class from `packages/schemas/src/tool-capture.ts`. */
  toolAction: string | null;
  toolExitStatus: number | null;
  toolInputHash: string | null;
  toolName: string | null;
  /** Non-reversible digest of what the call acted on; null when unobservable. */
  toolTargetHash: string | null;
  toolWasDenied: boolean | null;
  toolWasInterrupted: boolean | null;
};

/**
 * Floor for every scorer in this module. Below it a session's trajectory has no
 * shape to measure — one repeated call out of three is noise, not a retry loop.
 */
export const TRAJECTORY_MIN_TOOL_CALLS = 5;

/**
 * Floor for the scorers that key on call identity (retry, thrash, re-read).
 * A session whose calls mostly carry no target hash — an agent whose payloads
 * name nothing, or an all-MCP session — cannot be scored on repetition, and
 * scoring the observable minority would over-weight it.
 */
export const TRAJECTORY_MIN_KEYED_CALLS = 4;

/** A target must be touched this many times before it counts as thrash. */
export const EDIT_THRASH_MIN_REPEATS = 3;

/**
 * Same-shape sessions needed before a step-efficiency baseline means anything.
 * Below this the "baseline" is one or two sessions and the ratio measures them,
 * not the session being scored.
 */
export const STEP_EFFICIENCY_MIN_BASELINE_SESSIONS = 20;

export type ToolRole = 'read' | 'write' | 'exec' | 'other';

/**
 * Tool names whose role differs from the shared `READ_TOOLS`/`WRITE_TOOLS`/
 * `EXEC_TOOLS` sets, keyed by `agent_type`. This is the agent-neutrality seam:
 * the base sets cover the names every agent happens to share (case-insensitively
 * — opencode's `edit` is Claude Code's `Edit`), and this table covers the names
 * that genuinely diverge.
 *
 * Adding an agent means adding a row here, not forking a scorer.
 */
const AGENT_TOOL_ROLES: Record<string, Record<string, ToolRole>> = {
  CODEX: {
    apply_patch: 'write',
    'container.exec': 'exec',
    edit_file: 'write',
    local_shell: 'exec',
    read_file: 'read',
    shell: 'exec',
    write_file: 'write',
  },
  OPENCODE: {
    list: 'read',
    patch: 'write',
    todoread: 'other',
    todowrite: 'other',
    webfetch: 'read',
  },
};

const LOWER_READ = new Set([...READ_TOOLS].map((t) => t.toLowerCase()));
const LOWER_WRITE = new Set([...WRITE_TOOLS].map((t) => t.toLowerCase()));
const LOWER_EXEC = new Set([...EXEC_TOOLS].map((t) => t.toLowerCase()));

/**
 * Resolve a tool name to the role its *semantics* give it, for the agent that
 * emitted it. The per-agent table wins over the shared sets, so an agent that
 * reuses a shared name for something else stays correct.
 */
export function toolRole(agentType: string, toolName: string | null): ToolRole {
  if (toolName === null || toolName.length === 0) {
    return 'other';
  }
  const perAgent = AGENT_TOOL_ROLES[agentType]?.[toolName.toLowerCase()];
  if (perAgent !== undefined) {
    return perAgent;
  }
  const lower = toolName.toLowerCase();
  if (LOWER_READ.has(lower)) {
    return 'read';
  }
  if (LOWER_WRITE.has(lower)) {
    return 'write';
  }
  if (LOWER_EXEC.has(lower)) {
    return 'exec';
  }
  return 'other';
}

/** Completed tool calls only. A PreToolUse has no outcome to score. */
function isToolCall(e: TrajectoryEvent): boolean {
  return e.eventType === 'PostToolUse' && e.toolName !== null && e.toolName.length > 0;
}

/**
 * The finest-grained identity available for a call: the input hash when the
 * adapter captured one, otherwise the target digest. Both are content-free.
 * Null means the call cannot be compared to any other and is excluded — never
 * bucketed with the other unknowns, which would fabricate repeats.
 */
function callKey(e: TrajectoryEvent): string | null {
  const identity = e.toolInputHash ?? e.toolTargetHash;
  return identity === null ? null : `${e.toolName}\u0000${identity}`;
}

function toolCalls(events: readonly TrajectoryEvent[]): TrajectoryEvent[] {
  return events.filter(isToolCall);
}

/** A call that finished without a non-zero exit and was not denied/interrupted. */
function succeeded(e: TrajectoryEvent): boolean {
  return (
    e.toolWasDenied !== true &&
    e.toolWasInterrupted !== true &&
    (e.toolExitStatus === null || e.toolExitStatus === 0)
  );
}

// ── 1. Retry loop ────────────────────────────────────────────────────────────

/**
 * How much of the session was spent re-issuing calls it had already made.
 *
 * Repeats are counted per identical `(tool, input identity)` and weighted by
 * whether the outcome *changed*: a call retried after a genuine transient
 * failure eventually returns a different exit status, and that is a recovery,
 * not thrash. Repeats that keep producing the same outcome are the real signal —
 * the agent is stuck.
 *
 * Returns a rate in [0, 1] over the identifiable calls, so a long session and a
 * short one are comparable. Null below `TRAJECTORY_MIN_TOOL_CALLS` /
 * `TRAJECTORY_MIN_KEYED_CALLS`.
 */
export function retryLoopScore(events: readonly TrajectoryEvent[]): number | null {
  const calls = toolCalls(events);
  if (calls.length < TRAJECTORY_MIN_TOOL_CALLS) {
    return null;
  }

  const groups = new Map<string, { statuses: Set<string>; total: number }>();
  let keyed = 0;
  for (const e of calls) {
    const key = callKey(e);
    if (key === null) {
      continue;
    }
    keyed++;
    const group = groups.get(key) ?? { statuses: new Set<string>(), total: 0 };
    group.total++;
    group.statuses.add(
      e.toolWasDenied === true
        ? 'denied'
        : e.toolExitStatus === null
          ? 'null'
          : `${e.toolExitStatus}`,
    );
    groups.set(key, group);
  }
  if (keyed < TRAJECTORY_MIN_KEYED_CALLS) {
    return null;
  }

  let penalty = 0;
  for (const group of groups.values()) {
    if (group.total < 2) {
      continue;
    }
    // Half weight when the outcome moved: that repeat bought information.
    penalty += (group.total - 1) * (group.statuses.size > 1 ? 0.5 : 1);
  }
  return Math.min(1, penalty / keyed);
}

// ── 2. Edit thrash ───────────────────────────────────────────────────────────

/**
 * How much of the session's writing went into targets it kept re-writing.
 *
 * Only writes past the `EDIT_THRASH_MIN_REPEATS`-th touch of a target count: a
 * target touched exactly `EDIT_THRASH_MIN_REPEATS` times (write, test, fix) is
 * still ordinary and contributes 0; the touch after that is the first one that
 * counts as a pattern. Writes with no observable target are excluded from both
 * numerator and denominator so an agent that names nothing scores null rather
 * than zero.
 */
export function editThrashScore(events: readonly TrajectoryEvent[]): number | null {
  const calls = toolCalls(events);
  if (calls.length < TRAJECTORY_MIN_TOOL_CALLS) {
    return null;
  }

  const perTarget = new Map<string, number>();
  let writes = 0;
  for (const e of calls) {
    if (toolRole(e.agentType, e.toolName) !== 'write' || e.toolTargetHash === null) {
      continue;
    }
    writes++;
    perTarget.set(e.toolTargetHash, (perTarget.get(e.toolTargetHash) ?? 0) + 1);
  }
  if (writes < TRAJECTORY_MIN_KEYED_CALLS) {
    return null;
  }

  let thrash = 0;
  for (const count of perTarget.values()) {
    if (count > EDIT_THRASH_MIN_REPEATS) {
      thrash += count - EDIT_THRASH_MIN_REPEATS;
    }
  }
  return Math.min(1, thrash / writes);
}

// ── 3. Redundant re-read ─────────────────────────────────────────────────────

/**
 * Fraction of reads that re-read a target already read, with no write to that
 * target in between.
 *
 * The intervening-write rule is the whole scorer. Re-reading a file *after*
 * editing it is correct behaviour — the agent is verifying its own change — and
 * a naive "same target read twice" counter would flag exactly the sessions doing
 * the right thing. The fixture suite carries that case explicitly.
 *
 * Writes to a target reset it, so read → write → read → read scores one
 * redundant read, not two.
 *
 * A read only establishes "already read" for a target once it *succeeds*. A
 * denied or interrupted read never observed the target, so it must not make
 * the eventual successful read look redundant — the sequence denied-read →
 * approve → read-again is permission friction, not repetition, and scores 0.
 */
export function redundantReadScore(events: readonly TrajectoryEvent[]): number | null {
  const calls = toolCalls(events);
  if (calls.length < TRAJECTORY_MIN_TOOL_CALLS) {
    return null;
  }

  const seen = new Set<string>();
  let reads = 0;
  let redundant = 0;
  for (const e of calls) {
    if (e.toolTargetHash === null) {
      continue;
    }
    const role = toolRole(e.agentType, e.toolName);
    if (role === 'write') {
      // The target changed: everything read before this is legitimately stale.
      seen.delete(e.toolTargetHash);
      continue;
    }
    if (role !== 'read') {
      continue;
    }
    reads++;
    if (seen.has(e.toolTargetHash)) {
      redundant++;
    } else if (succeeded(e)) {
      // A read that did not succeed (denied, interrupted, non-zero exit)
      // never happened as far as the target is concerned: it must not
      // establish "already read", or the eventual successful read scores as
      // the redundant one.
      seen.add(e.toolTargetHash);
    }
  }
  if (reads < TRAJECTORY_MIN_KEYED_CALLS) {
    return null;
  }
  return Math.min(1, redundant / reads);
}

// ── 4. Denial → retry → success ──────────────────────────────────────────────

/**
 * Count of distinct calls that were denied, retried, and then succeeded.
 *
 * This is a **permission-configuration smell, not a developer failing**: the
 * work was legitimate (it eventually succeeded), and the only thing the denial
 * bought was a round trip. A high count is an argument for widening an allowlist.
 *
 * Returns a count rather than a rate — unlike the rates above, the actionable
 * quantity here is "how many times did this happen", and a count of 3 in a
 * 200-call session is still three permission prompts a human answered. The
 * `value` column carries counts and rates alike; the scorer's description in
 * `SCORERS` says which this one is.
 *
 * Zero is a real answer (no denials, or denials that never recovered) and is
 * emitted; null means the session was too small to characterize.
 */
export function denialRetrySuccessCount(events: readonly TrajectoryEvent[]): number | null {
  const calls = toolCalls(events);
  if (calls.length < TRAJECTORY_MIN_TOOL_CALLS) {
    return null;
  }

  const denied = new Set<string>();
  const recovered = new Set<string>();
  let keyed = 0;
  for (const e of calls) {
    const key = callKey(e);
    if (key === null) {
      continue;
    }
    keyed++;
    if (e.toolWasDenied === true) {
      denied.add(key);
      continue;
    }
    // Order matters: only a success *after* the denial counts.
    if (denied.has(key) && succeeded(e)) {
      recovered.add(key);
    }
  }
  if (keyed < TRAJECTORY_MIN_KEYED_CALLS) {
    return null;
  }
  return recovered.size;
}

// ── 5. Tests run ─────────────────────────────────────────────────────────────

/**
 * Did the session run a test command?
 *
 * `true` / `false` / null, where null means *unobservable*: the session issued
 * no classified shell command at all, so "no tests" and "no shell" are not
 * conflated. An agent whose adapter does not derive `toolAction` therefore
 * scores null rather than a misleading `false`.
 *
 * The caller decides which sessions this is worth writing for — the
 * "before merge" half of `tests-run-before-merge` is a property of the linked
 * pull request, not of the trajectory, and lives in the job.
 */
export function testCommandRun(events: readonly TrajectoryEvent[]): boolean | null {
  const calls = toolCalls(events);
  if (calls.length < TRAJECTORY_MIN_TOOL_CALLS) {
    return null;
  }
  let classified = 0;
  let tests = 0;
  for (const e of calls) {
    if (e.toolAction === null) {
      continue;
    }
    classified++;
    if (e.toolAction === 'test') {
      tests++;
    }
  }
  if (classified === 0) {
    return null;
  }
  return tests > 0;
}

// ── 6. Step efficiency ───────────────────────────────────────────────────────

/**
 * The baseline a session's step count is measured against: the median tool-call
 * count of same-shape sessions. Derived from the data rather than hardcoded, and
 * recorded in the score's `metadata` so a later reader can tell what the number
 * was measured against — a ratio whose denominator has been lost is unreadable.
 */
export type StepEfficiencyBaseline = {
  medianToolCalls: number;
  sessionCount: number;
  shapeLabel: string;
};

/**
 * Tool calls relative to the per-shape baseline. 1.0 is typical for the shape;
 * 2.0 took twice as many steps as the median session of its kind.
 *
 * Deliberately *not* inverted into a 0–1 "efficiency": a ratio keeps the units
 * legible and does not imply that fewer steps is always better. Whether it
 * predicts anything is P13-007's question; this scorer only records it.
 */
export function stepEfficiencyRatio(
  toolCallCount: number,
  baseline: StepEfficiencyBaseline | undefined,
): number | null {
  if (baseline === undefined || toolCallCount < TRAJECTORY_MIN_TOOL_CALLS) {
    return null;
  }
  if (baseline.sessionCount < STEP_EFFICIENCY_MIN_BASELINE_SESSIONS) {
    return null;
  }
  if (!(baseline.medianToolCalls > 0)) {
    return null;
  }
  return toolCallCount / baseline.medianToolCalls;
}
