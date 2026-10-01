import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { eventsFor } from '../hook-entry';
import { claudeCodeAdapter } from './claude-code';
import { conformanceErrors } from './conformance';

const BIN = '/usr/local/bin/aiot';
const SESSION_ID = '3f8c2a1e-9d47-4b6a-8c25-1e7f0a9b4d63';

type HookEntry = { args: string[]; command: string; type: string };
type HookGroup = { hooks: HookEntry[] };

describe('claudeCodeAdapter', () => {
  it('emits EventSchema-conformant events', () => {
    const tool = claudeCodeAdapter.mapPayload('pre-tool-use', {
      cwd: '/home/dev/proj',
      hook_event_name: 'PreToolUse',
      session_id: SESSION_ID,
      tool_input: { command: 'ls' },
      tool_name: 'Bash',
    });
    expect(conformanceErrors(tool)).toEqual([]);
    // Claude Code already hands out UUIDs — normalization must not rewrite them,
    // or the id users see in Claude Code would stop matching ours (P12-002).
    expect(tool.session_id).toBe(SESSION_ID);
  });

  it('keys the shipped transcript to the same session_id as the events', () => {
    const raw = { session_id: SESSION_ID, transcript_path: '/home/dev/.claude/x.jsonl' };
    const stop = claudeCodeAdapter.mapPayload('stop', raw);
    expect(claudeCodeAdapter.transcriptTarget('stop', raw)?.sessionId).toBe(stop.session_id);
  });
});

// Claude Code's SessionEnd hook fires however a session ends, with the same base
// fields as Stop plus `reason`. Stop never fires if the user quits mid-response,
// so without this kind the session never got its closing event or final
// transcript ship marker.
describe('claudeCodeAdapter — SessionEnd', () => {
  const raw = {
    cwd: '/home/dev/proj',
    hook_event_name: 'SessionEnd',
    reason: 'prompt_input_exit',
    session_id: SESSION_ID,
    transcript_path: '/home/dev/.claude/projects/-home-dev-proj/3f8c2a1e.jsonl',
  };

  it('maps session-end to a conformant SessionEnd event', () => {
    expect(claudeCodeAdapter.isHookKind('session-end')).toBe(true);
    const events = eventsFor(claudeCodeAdapter, 'session-end', raw);
    expect(events).toHaveLength(1);
    expect(events[0]?.event_type).toBe('SessionEnd');
    expect(events[0]?.session_id).toBe(SESSION_ID);
    expect(conformanceErrors(events[0] as never)).toEqual([]);
  });

  it('writes a ship marker for the transcript, like Stop', () => {
    expect(claudeCodeAdapter.transcriptTarget('session-end', raw)).toEqual({
      sessionId: SESSION_ID,
      transcriptPath: raw.transcript_path,
    });
  });

  it('does not read the transcript for usage (the Stop hook owns that cursor)', () => {
    expect(claudeCodeAdapter.mapBatch?.('session-end', raw) ?? null).toBeNull();
  });
});

describe('claudeCodeAdapter install — upgrading an existing 8-hook install', () => {
  let tmpHome: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'aiot-claude-upgrade-'));
    origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    mkdirSync(join(tmpHome, '.claude'), { recursive: true });
  });

  afterEach(() => {
    if (origHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = origHome;
    }
    rmSync(tmpHome, { force: true, recursive: true });
  });

  it('adds SessionEnd on re-run, keeps user hooks, and never duplicates ours', () => {
    const settingsPath = join(tmpHome, '.claude', 'settings.json');
    const userHook = { hooks: [{ command: '/usr/bin/notify-send', type: 'command' }] };
    // What a pre-SessionEnd release wrote: the 8 original kinds only.
    const old = JSON.parse(claudeCodeAdapter.installConfig().renderSnippet(BIN)) as {
      hooks: Record<string, HookGroup[]>;
    };
    delete old.hooks.SessionEnd;
    writeFileSync(
      settingsPath,
      JSON.stringify({ hooks: { ...old.hooks, Stop: [userHook, ...(old.hooks.Stop ?? [])] } }),
    );

    const { apply } = claudeCodeAdapter.installConfig();
    expect(apply?.(BIN)).toContain(settingsPath);
    expect(apply?.(BIN)).toContain(settingsPath); // idempotent second run

    const { hooks } = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      hooks: Record<string, Array<HookGroup | typeof userHook>>;
    };
    expect(hooks.SessionEnd).toEqual([
      { hooks: [{ args: ['hook', 'session-end'], command: BIN, type: 'command' }] },
    ]);
    expect(hooks.Stop).toHaveLength(2);
    expect(hooks.Stop?.[0]).toEqual(userHook);
    expect(Object.keys(hooks)).toHaveLength(9);
  });

  it('uninstall removes the SessionEnd entry along with the others, keeping user hooks', () => {
    const settingsPath = join(tmpHome, '.claude', 'settings.json');
    const userHook = { hooks: [{ command: '/usr/bin/notify-send', type: 'command' }] };
    writeFileSync(settingsPath, JSON.stringify({ hooks: { SessionEnd: [userHook] } }));
    const { apply, remove } = claudeCodeAdapter.installConfig();
    apply?.(BIN);
    expect(remove?.()).toBe(true);

    const { hooks } = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      hooks: Record<string, unknown[]>;
    };
    expect(hooks).toEqual({ SessionEnd: [userHook] });
  });
});

// P14-010: Claude Code's own PostToolUse hook-input schema carries
// `duration_ms: o().optional()` (confirmed against the shipped binary) — the one
// adapter with a documented, real timing field. Absence must read as unknown,
// never as a measured 0.
describe('claudeCodeAdapter — PostToolUse duration_ms (P14-010)', () => {
  function postToolUse(extra: Record<string, unknown>) {
    return claudeCodeAdapter.mapPayload('post-tool-use', {
      cwd: '/home/dev/proj',
      session_id: SESSION_ID,
      tool_input: { command: 'ls' },
      tool_name: 'Bash',
      ...extra,
    });
  }

  it('passes a real duration through unchanged', () => {
    const ev = postToolUse({ duration_ms: 245 });
    expect(ev.tool?.duration_ms).toBe(245);
    expect(conformanceErrors(ev)).toEqual([]);
  });

  it('leaves duration_ms null rather than 0 when the payload omits it', () => {
    const ev = postToolUse({});
    expect(ev.tool?.duration_ms).toBe(null);
    expect(conformanceErrors(ev)).toEqual([]);
  });

  it('PreToolUse never carries duration_ms, and reads as null too', () => {
    const ev = claudeCodeAdapter.mapPayload('pre-tool-use', {
      cwd: '/home/dev/proj',
      session_id: SESSION_ID,
      tool_input: { command: 'ls' },
      tool_name: 'Bash',
    });
    expect(ev.tool?.duration_ms).toBe(null);
  });

  it('treats a malformed duration_ms as unknown rather than crashing or coercing to 0', () => {
    const malformed = [
      'fast',
      -12,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      null,
      { ms: 5 },
      [5],
      true,
    ];
    for (const value of malformed) {
      const ev = postToolUse({ duration_ms: value });
      expect(ev.tool?.duration_ms).toBe(null);
      expect(conformanceErrors(ev)).toEqual([]);
    }
  });

  it('never throws for a malformed duration_ms — the always-exit-0 guarantee', () => {
    const malformed = ['fast', -12, Number.NaN, {}, [], Symbol('x')];
    for (const value of malformed) {
      expect(() =>
        eventsFor(claudeCodeAdapter, 'post-tool-use', {
          cwd: '/home/dev/proj',
          duration_ms: value,
          session_id: SESSION_ID,
          tool_input: { command: 'ls' },
          tool_name: 'Bash',
        }),
      ).not.toThrow();
    }
  });
});

describe('claudeCodeAdapter.installConfig().renderSnippet', () => {
  const raw = claudeCodeAdapter.installConfig().renderSnippet(BIN);

  it('produces valid JSON', () => {
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('has a top-level "hooks" key', () => {
    const parsed = JSON.parse(raw);
    expect(parsed).toHaveProperty('hooks');
    expect(typeof parsed.hooks).toBe('object');
  });

  it('uses PascalCase event names — no kebab-case keys', () => {
    const { hooks } = JSON.parse(raw) as { hooks: Record<string, unknown> };
    for (const key of Object.keys(hooks)) {
      expect(key).toMatch(/^[A-Z]/); // starts with uppercase
      expect(key).not.toContain('-'); // no kebab-case
    }
  });

  it('registers exactly the expected 9 event names', () => {
    const { hooks } = JSON.parse(raw) as { hooks: Record<string, unknown> };
    expect(Object.keys(hooks).sort()).toEqual(
      [
        'Notification',
        'PostToolUse',
        'PreCompact',
        'PreToolUse',
        'SessionEnd',
        'SessionStart',
        'Stop',
        'SubagentStop',
        'UserPromptSubmit',
      ].sort(),
    );
  });

  it('each event value is an array of one hook-group object', () => {
    const { hooks } = JSON.parse(raw) as { hooks: Record<string, HookGroup[]> };
    for (const [, groups] of Object.entries(hooks)) {
      expect(Array.isArray(groups)).toBe(true);
      expect(groups.length).toBe(1);
      expect(groups[0]).toHaveProperty('hooks');
      expect(Array.isArray(groups[0]?.hooks)).toBe(true);
    }
  });

  it('uses exec form — command is the binary path and args carries the subcommand', () => {
    const { hooks } = JSON.parse(raw) as { hooks: Record<string, HookGroup[]> };
    const expectedArgs: Record<string, string[]> = {
      Notification: ['hook', 'notification'],
      PostToolUse: ['hook', 'post-tool-use'],
      PreCompact: ['hook', 'pre-compact'],
      PreToolUse: ['hook', 'pre-tool-use'],
      SessionEnd: ['hook', 'session-end'],
      SessionStart: ['hook', 'session-start'],
      Stop: ['hook', 'stop'],
      SubagentStop: ['hook', 'subagent-stop'],
      UserPromptSubmit: ['hook', 'user-prompt-submit'],
    };
    for (const [eventName, groups] of Object.entries(hooks)) {
      const entry = groups[0]?.hooks[0];
      expect(entry?.type).toBe('command');
      expect(entry?.command).toBe(BIN);
      expect(entry?.args ?? []).toEqual(expectedArgs[eventName] ?? []);
    }
  });

  it('binary path with spaces does not contaminate args (exec form safety)', () => {
    const spacedBin = '/home/jorge barnaby/.local/bin/aiot';
    const result = JSON.parse(claudeCodeAdapter.installConfig().renderSnippet(spacedBin)) as {
      hooks: Record<string, HookGroup[]>;
    };
    const entry = result.hooks.Stop?.[0]?.hooks[0];
    expect(entry?.command).toBe(spacedBin);
    expect(entry?.args).toEqual(['hook', 'stop']);
  });
});
