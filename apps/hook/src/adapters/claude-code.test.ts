import { describe, expect, it } from 'bun:test';

import { claudeCodeAdapter } from './claude-code';

const BIN = '/usr/local/bin/claude-telemetry';

type HookEntry = { args: string[]; command: string; type: string };
type HookGroup = { hooks: HookEntry[] };

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

  it('registers exactly the expected 8 event names', () => {
    const { hooks } = JSON.parse(raw) as { hooks: Record<string, unknown> };
    expect(Object.keys(hooks).sort()).toEqual(
      [
        'Notification',
        'PostToolUse',
        'PreCompact',
        'PreToolUse',
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
    const spacedBin = '/home/jorge barnaby/.local/bin/claude-telemetry';
    const result = JSON.parse(claudeCodeAdapter.installConfig().renderSnippet(spacedBin)) as {
      hooks: Record<string, HookGroup[]>;
    };
    const entry = result.hooks.Stop?.[0]?.hooks[0];
    expect(entry?.command).toBe(spacedBin);
    expect(entry?.args).toEqual(['hook', 'stop']);
  });
});
