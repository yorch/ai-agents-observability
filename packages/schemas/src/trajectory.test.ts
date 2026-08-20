import { describe, expect, it } from 'vitest';

import { classifyCommandAction, targetDigest, toolActionFor, toolTargetHash } from './tool-capture';
import {
  denialRetrySuccessCount,
  editThrashScore,
  redundantReadScore,
  retryLoopScore,
  stepEfficiencyRatio,
  type TrajectoryEvent,
  testCommandRun,
  toolRole,
} from './trajectory';

// ── Fixture builder ──────────────────────────────────────────────────────────
//
// Trajectories are written as terse call lists so a fixture reads like the
// session it describes. Every scorer takes an *ordered* list, so order in the
// array is order in time.

type CallSpec = {
  action?: string | null;
  agent?: string;
  denied?: boolean;
  exit?: number | null;
  hash?: string | null;
  target?: string | null;
  tool: string;
};

function call(spec: CallSpec): TrajectoryEvent {
  return {
    agentType: spec.agent ?? 'CLAUDE_CODE',
    eventType: 'PostToolUse',
    toolAction: spec.action ?? null,
    toolExitStatus: spec.exit === undefined ? 0 : spec.exit,
    toolInputHash: spec.hash ?? null,
    toolName: spec.tool,
    toolTargetHash: spec.target ?? null,
    toolWasDenied: spec.denied ?? false,
    toolWasInterrupted: false,
  };
}

function calls(...specs: CallSpec[]): TrajectoryEvent[] {
  return specs.map(call);
}

/** Filler successful reads of distinct targets — volume with no signal. */
function filler(n: number, from = 0): TrajectoryEvent[] {
  return Array.from({ length: n }, (_, i) => call({ target: `filler-${from + i}`, tool: 'Read' }));
}

// ── Capture helpers ──────────────────────────────────────────────────────────

describe('tool-capture', () => {
  it('digests are stable, non-reversible-looking, and target-distinguishing', () => {
    expect(targetDigest('src/app.ts')).toBe(targetDigest('src/app.ts'));
    expect(targetDigest('src/app.ts')).not.toBe(targetDigest('src/app.tsx'));
    expect(targetDigest('src/app.ts')).toMatch(/^[0-9a-f]{16}$/);
    expect(targetDigest('src/app.ts')).not.toContain('src');
  });

  it('picks the path over the command when a payload carries both', () => {
    const withPath = toolTargetHash({ command: 'cat x', file_path: '/repo/a.ts' });
    expect(withPath).toBe(targetDigest('/repo/a.ts'));
  });

  it('returns null when nothing in the payload names a target', () => {
    expect(toolTargetHash({ subagent_type: 'explore' })).toBeNull();
    expect(toolTargetHash(null)).toBeNull();
    expect(toolTargetHash(42)).toBeNull();
  });

  it('classifies commands with VCS and package installs winning over word matches', () => {
    expect(classifyCommandAction('bun run test')).toBe('test');
    expect(classifyCommandAction('vitest run src/')).toBe('test');
    // Adversarial: a branch name containing "test" must not read as a test run.
    expect(classifyCommandAction('git checkout -b feat/test-harness')).toBe('vcs');
    // Adversarial: an install that also mentions a test package is an install.
    expect(classifyCommandAction('npm install --save-dev vitest')).toBe('pkg');
    expect(classifyCommandAction('biome check .')).toBe('lint');
    expect(classifyCommandAction('tsc --noEmit')).toBe('build');
    expect(classifyCommandAction('ls -la')).toBe('other');
    expect(classifyCommandAction('   ')).toBeNull();
  });

  it('only classifies payloads that carry a command', () => {
    expect(toolActionFor({ command: 'bun test' })).toBe('test');
    expect(toolActionFor({ file_path: '/repo/a.ts' })).toBeNull();
  });
});

// ── Agent neutrality ─────────────────────────────────────────────────────────

describe('toolRole', () => {
  it('resolves shared names case-insensitively across agents', () => {
    expect(toolRole('CLAUDE_CODE', 'Edit')).toBe('write');
    expect(toolRole('OPENCODE', 'edit')).toBe('write');
    expect(toolRole('OPENCODE', 'bash')).toBe('exec');
    expect(toolRole('CLAUDE_CODE', 'Read')).toBe('read');
  });

  it('branches on agent_type where the names genuinely diverge', () => {
    expect(toolRole('CODEX', 'apply_patch')).toBe('write');
    expect(toolRole('CODEX', 'shell')).toBe('exec');
    expect(toolRole('CODEX', 'read_file')).toBe('read');
  });

  it('resolves self-describing names for any agent, including ones with no table', () => {
    // Phase 12 took the seam to seven agents. Enumerating every vocabulary is not
    // possible, so names that carry their own role resolve everywhere — otherwise
    // the target-keyed scorers would be dead for Gemini CLI, Copilot CLI, Pi and
    // omp while working for Claude Code. This deliberately replaces the older rule
    // that such a name fell through to 'other' outside its declaring agent.
    expect(toolRole('GEMINI_CLI', 'run_shell_command')).toBe('exec');
    expect(toolRole('COPILOT', 'write_file')).toBe('write');
    expect(toolRole('PI', 'read_file')).toBe('read');
    expect(toolRole('OMP', 'apply_patch')).toBe('write');
    // An agent with no table at all still resolves them.
    expect(toolRole('SOME_FUTURE_AGENT', 'edit_file')).toBe('write');
  });

  it('lets a per-agent table win over the shared name layer', () => {
    // The precedence that keeps the shared layer safe: an agent that reuses a
    // shared name for something else declares it and stays correct.
    expect(toolRole('OPENCODE', 'patch')).toBe('write');
    expect(toolRole('OPENCODE', 'todowrite')).toBe('other');
  });

  it('treats unknown and missing tools as other', () => {
    expect(toolRole('CLAUDE_CODE', 'mcp__linear__list_issues')).toBe('other');
    expect(toolRole('CLAUDE_CODE', null)).toBe('other');
  });
});

// ── 1. Retry loop ────────────────────────────────────────────────────────────

describe('retryLoopScore', () => {
  it('returns null for a session too small to characterize', () => {
    expect(retryLoopScore(calls({ target: 'a', tool: 'Read' }))).toBeNull();
    expect(retryLoopScore([])).toBeNull();
  });

  it('returns null when too few calls carry an identity', () => {
    // Ten MCP calls, none of which names a target: volume without observability.
    const opaque = Array.from({ length: 10 }, () => call({ tool: 'mcp__x__y' }));
    expect(retryLoopScore(opaque)).toBeNull();
  });

  it('scores zero when every call is distinct', () => {
    expect(retryLoopScore(filler(8))).toBe(0);
  });

  it('penalizes a stuck loop that keeps producing the same failure', () => {
    const stuck = [
      ...filler(4),
      ...calls(
        { exit: 1, target: 'x', tool: 'Bash' },
        { exit: 1, target: 'x', tool: 'Bash' },
        { exit: 1, target: 'x', tool: 'Bash' },
        { exit: 1, target: 'x', tool: 'Bash' },
      ),
    ];
    // 3 unproductive repeats over 8 identifiable calls.
    expect(retryLoopScore(stuck)).toBeCloseTo(3 / 8, 6);
  });

  it('adversarial: a retry after a transient failure is discounted, not counted as thrash', () => {
    const recovered = [
      ...filler(4),
      ...calls({ exit: 1, target: 'x', tool: 'Bash' }, { exit: 0, target: 'x', tool: 'Bash' }),
    ];
    const stuck = [
      ...filler(4),
      ...calls({ exit: 1, target: 'x', tool: 'Bash' }, { exit: 1, target: 'x', tool: 'Bash' }),
    ];
    const recoveredScore = retryLoopScore(recovered) ?? 0;
    const stuckScore = retryLoopScore(stuck) ?? 0;
    expect(recoveredScore).toBeCloseTo(0.5 / 6, 6);
    expect(recoveredScore).toBeLessThan(stuckScore);
  });

  it('does not conflate the same target across different tools', () => {
    const distinct = [
      ...filler(4),
      ...calls({ target: 'x', tool: 'Read' }, { target: 'x', tool: 'Edit' }),
    ];
    expect(retryLoopScore(distinct)).toBe(0);
  });

  it('prefers the input hash over the target when the adapter captured one', () => {
    const sameFileDifferentEdits = [
      ...filler(4),
      ...calls(
        { hash: 'h1', target: 'x', tool: 'Edit' },
        { hash: 'h2', target: 'x', tool: 'Edit' },
      ),
    ];
    expect(retryLoopScore(sameFileDifferentEdits)).toBe(0);
  });
});

// ── 2. Edit thrash ───────────────────────────────────────────────────────────

describe('editThrashScore', () => {
  it('returns null below the write-volume floor', () => {
    const fewWrites = [...filler(6), ...calls({ target: 'a', tool: 'Edit' })];
    expect(editThrashScore(fewWrites)).toBeNull();
  });

  it('adversarial: many writes across many distinct files is not thrash', () => {
    const spread = [
      ...filler(3),
      ...calls(
        { target: 'a', tool: 'Edit' },
        { target: 'b', tool: 'Edit' },
        { target: 'c', tool: 'Edit' },
        { target: 'd', tool: 'Write' },
        { target: 'e', tool: 'Edit' },
      ),
    ];
    expect(editThrashScore(spread)).toBe(0);
  });

  it('adversarial: two edits to one file is ordinary work, not thrash', () => {
    const normal = [
      ...filler(3),
      ...calls(
        { target: 'a', tool: 'Edit' },
        { target: 'a', tool: 'Edit' },
        { target: 'b', tool: 'Edit' },
        { target: 'c', tool: 'Edit' },
      ),
    ];
    expect(editThrashScore(normal)).toBe(0);
  });

  it('boundary: a target touched exactly EDIT_THRASH_MIN_REPEATS times is still ordinary', () => {
    const atThreshold = [
      ...filler(3),
      ...calls(
        { target: 'a', tool: 'Edit' },
        { target: 'a', tool: 'Edit' },
        { target: 'a', tool: 'Edit' },
        { target: 'b', tool: 'Edit' },
      ),
    ];
    // 3 touches of `a` == EDIT_THRASH_MIN_REPEATS: at the threshold, not past it.
    expect(editThrashScore(atThreshold)).toBe(0);
  });

  it('flags a file rewritten well past the repeat threshold', () => {
    const thrash = [
      ...filler(3),
      ...calls(
        { target: 'a', tool: 'Edit' },
        { target: 'a', tool: 'Edit' },
        { target: 'a', tool: 'Edit' },
        { target: 'a', tool: 'Edit' },
        { target: 'b', tool: 'Edit' },
      ),
    ];
    // 4 touches of `a` → 1 beyond the threshold, over 5 targeted writes.
    expect(thrash.length).toBeGreaterThan(0);
    expect(editThrashScore(thrash)).toBeCloseTo(1 / 5, 6);
  });

  it('counts an agent-specific write tool', () => {
    const codex = [
      ...filler(3),
      ...calls(
        { agent: 'CODEX', target: 'a', tool: 'apply_patch' },
        { agent: 'CODEX', target: 'a', tool: 'apply_patch' },
        { agent: 'CODEX', target: 'a', tool: 'apply_patch' },
        { agent: 'CODEX', target: 'a', tool: 'apply_patch' },
        { agent: 'CODEX', target: 'b', tool: 'apply_patch' },
      ),
    ];
    // 4 touches of `a` → 1 beyond the threshold, over 5 targeted writes.
    expect(editThrashScore(codex)).toBeCloseTo(1 / 5, 6);
  });
});

// ── 3. Redundant re-read ─────────────────────────────────────────────────────

describe('redundantReadScore', () => {
  it('returns null below the read-volume floor', () => {
    const fewReads = [
      ...calls(
        { target: 'a', tool: 'Read' },
        { target: 'a', tool: 'Edit' },
        { target: 'b', tool: 'Edit' },
        { target: 'c', tool: 'Edit' },
        { target: 'd', tool: 'Edit' },
      ),
    ];
    expect(redundantReadScore(fewReads)).toBeNull();
  });

  it('adversarial: re-reading a file after editing it is correct behaviour', () => {
    const verify = calls(
      { target: 'a', tool: 'Read' },
      { target: 'b', tool: 'Read' },
      { target: 'c', tool: 'Read' },
      { target: 'a', tool: 'Edit' },
      { target: 'a', tool: 'Read' },
      { target: 'd', tool: 'Read' },
    );
    expect(redundantReadScore(verify)).toBe(0);
  });

  it('flags a re-read with no intervening write', () => {
    const wasteful = calls(
      { target: 'a', tool: 'Read' },
      { target: 'b', tool: 'Read' },
      { target: 'a', tool: 'Read' },
      { target: 'c', tool: 'Read' },
      { target: 'a', tool: 'Read' },
    );
    expect(redundantReadScore(wasteful)).toBeCloseTo(2 / 5, 6);
  });

  it('adversarial: a denied read does not establish "already read" for the retry that succeeds', () => {
    // Agent reads /etc/foo -> denied -> developer approves -> agent reads
    // /etc/foo again -> succeeds. The successful read must not score as
    // redundant just because a denied attempt touched the same target first.
    const deniedThenApproved = calls(
      { denied: true, exit: null, target: 'a', tool: 'Read' },
      { target: 'a', tool: 'Read' },
      { target: 'b', tool: 'Read' },
      { target: 'c', tool: 'Read' },
      { target: 'd', tool: 'Read' },
    );
    expect(redundantReadScore(deniedThenApproved)).toBe(0);
  });

  it('a write resets the target, so only reads after the last write can repeat', () => {
    const mixed = calls(
      { target: 'a', tool: 'Read' },
      { target: 'a', tool: 'Edit' },
      { target: 'a', tool: 'Read' },
      { target: 'a', tool: 'Read' },
      { target: 'b', tool: 'Read' },
      { target: 'c', tool: 'Read' },
    );
    expect(redundantReadScore(mixed)).toBeCloseTo(1 / 5, 6);
  });
});

// ── 4. Denial → retry → success ──────────────────────────────────────────────

describe('denialRetrySuccessCount', () => {
  it('returns null below the volume floor', () => {
    expect(denialRetrySuccessCount(calls({ denied: true, target: 'a', tool: 'Bash' }))).toBeNull();
  });

  it('emits zero when nothing was denied', () => {
    expect(denialRetrySuccessCount(filler(6))).toBe(0);
  });

  it('counts a denied call that was retried and then succeeded', () => {
    const chain = [
      ...filler(3),
      ...calls(
        { denied: true, exit: null, target: 'x', tool: 'Bash' },
        { exit: 0, target: 'x', tool: 'Bash' },
        { denied: true, exit: null, target: 'y', tool: 'Bash' },
        { exit: 0, target: 'y', tool: 'Bash' },
      ),
    ];
    expect(denialRetrySuccessCount(chain)).toBe(2);
  });

  it('adversarial: a denial that never recovered is not a permission smell', () => {
    const abandoned = [
      ...filler(4),
      ...calls(
        { denied: true, exit: null, target: 'x', tool: 'Bash' },
        { exit: 1, target: 'x', tool: 'Bash' },
      ),
    ];
    expect(denialRetrySuccessCount(abandoned)).toBe(0);
  });

  it('adversarial: a success BEFORE the denial does not count', () => {
    const ordered = [
      ...filler(4),
      ...calls(
        { exit: 0, target: 'x', tool: 'Bash' },
        { denied: true, exit: null, target: 'x', tool: 'Bash' },
      ),
    ];
    expect(denialRetrySuccessCount(ordered)).toBe(0);
  });
});

// ── 5. Tests run ─────────────────────────────────────────────────────────────

describe('testCommandRun', () => {
  it('returns null below the volume floor', () => {
    expect(testCommandRun(calls({ action: 'test', tool: 'Bash' }))).toBeNull();
  });

  it('returns null when no command in the session was classified at all', () => {
    // An adapter that derives no action must not make the session read as
    // "shipped without tests".
    expect(testCommandRun(filler(8))).toBeNull();
  });

  it('adversarial: one test run at the very end still counts', () => {
    const late = [
      ...filler(4),
      ...calls(
        { action: 'build', target: 'c1', tool: 'Bash' },
        { action: 'vcs', target: 'c2', tool: 'Bash' },
        { action: 'test', target: 'c3', tool: 'Bash' },
      ),
    ];
    expect(testCommandRun(late)).toBe(true);
  });

  it('reports false when commands ran but none were tests', () => {
    const noTests = [
      ...filler(4),
      ...calls(
        { action: 'vcs', target: 'c1', tool: 'Bash' },
        { action: 'build', target: 'c2', tool: 'Bash' },
      ),
    ];
    expect(testCommandRun(noTests)).toBe(false);
  });
});

// ── 6. Step efficiency ───────────────────────────────────────────────────────

describe('stepEfficiencyRatio', () => {
  const baseline = { medianToolCalls: 20, sessionCount: 50, shapeLabel: 'focused-edit' };

  it('returns null with no baseline for the shape', () => {
    expect(stepEfficiencyRatio(40, undefined)).toBeNull();
  });

  it('returns null when the baseline rests on too few sessions', () => {
    expect(
      stepEfficiencyRatio(40, { medianToolCalls: 20, sessionCount: 3, shapeLabel: 'debugging' }),
    ).toBeNull();
  });

  it('returns null below the session volume floor', () => {
    expect(stepEfficiencyRatio(2, baseline)).toBeNull();
  });

  it('returns null rather than dividing by a degenerate baseline', () => {
    expect(
      stepEfficiencyRatio(40, { medianToolCalls: 0, sessionCount: 100, shapeLabel: 'minimal' }),
    ).toBeNull();
  });

  it('reports the ratio against the same-shape median', () => {
    expect(stepEfficiencyRatio(40, baseline)).toBe(2);
    expect(stepEfficiencyRatio(20, baseline)).toBe(1);
    expect(stepEfficiencyRatio(10, baseline)).toBe(0.5);
  });
});
