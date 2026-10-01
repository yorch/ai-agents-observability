// Structural hook ownership (lib/config-wire.ts) and the self-heal it enables.
//
// The fixtures are the REAL shapes found in a developer's configs after the
// install-from-bun leak: Claude `{"hooks":[{"args":["hook","<kind>"],"command":
// "/home/x/.bun/bin/bun","type":"command"}]}` once per event per run, and Codex
// `{"command":["/home/x/.bun/bin/bun","hook","<kind>","--agent","codex"],"type":
// "command"}`, each next to the owner's own herdr hook. The old substring marker
// (`command.includes('aiot')`) recognised none of the bun entries, so every
// re-install appended another group; the idempotency test passed only because its
// BIN happened to contain "aiot".

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInstall } from '../commands/install';
import { stripOwnedEntries } from '../lib/config-wire';
import { claudeCodeAdapter } from './claude-code';
import { ADAPTERS } from './index';

const BUN = '/home/x/.bun/bin/bun';
const LAUNCHER = '/opt/aiot/aiot-linux-x64';
const DUPLICATES = 12;

let tmpHome: string;
let origHome: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'aiot-ownership-test-'));
  origHome = process.env.HOME;
  process.env.HOME = tmpHome;
});

afterEach(() => {
  if (origHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = origHome;
  }
  rmSync(tmpHome, { force: true, recursive: true });
});

function cfgFor(key: string) {
  const adapter = ADAPTERS[key];
  if (!adapter) {
    throw new Error(`no adapter ${key}`);
  }
  return adapter.installConfig();
}

function write(rel: string, content: string): string {
  const full = join(tmpHome, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
  return full;
}

type Hooks = Record<string, unknown[]>;
const readHooks = (path: string): Hooks => JSON.parse(readFileSync(path, 'utf8')).hooks;

// ── The predicate ─────────────────────────────────────────────────────────────

describe('stripOwnedEntries — ownership is structural', () => {
  const claudeGroup = (command: string, args: string[], extra: object = {}) => ({
    hooks: [{ args, command, type: 'command' }],
    ...extra,
  });

  it('removes the launcher, a cross-compiled launcher and the runtime', () => {
    for (const command of [
      '/usr/local/bin/aiot',
      '/opt/aiot/aiot-darwin-arm64',
      '/opt/aiot/aiot-runtime-linux-x64',
    ]) {
      expect(stripOwnedEntries([claudeGroup(command, ['hook', 'stop'])])).toEqual([]);
    }
  });

  it('removes the legacy `bun hook <kind>` group, in both shapes', () => {
    expect(stripOwnedEntries([claudeGroup(BUN, ['hook', 'stop'])])).toEqual([]);
    expect(
      stripOwnedEntries([{ command: [BUN, 'hook', 'stop', '--agent', 'codex'], type: 'command' }]),
    ).toEqual([]);
  });

  it('removes a Gemini entry (whole invocation in one quoted string, named aiot-<kind>)', () => {
    const entry = {
      hooks: [
        {
          command: `"/home/jorge barnaby/.local/bin/aiot" hook stop --agent gemini-cli`,
          name: 'aiot-stop',
          timeout: 5000,
          type: 'command',
        },
      ],
    };
    expect(stripOwnedEntries([entry])).toEqual([]);
    // ...and by invocation alone, when the name was edited away.
    const unnamed = { hooks: [{ command: '"/opt/aiot/aiot" hook stop', type: 'command' }] };
    expect(stripOwnedEntries([unnamed])).toEqual([]);
  });

  it('keeps foreign hooks byte-identical', () => {
    const foreign = [
      claudeGroup('bun', ['run', 'lint']),
      // a bun hook the user customised: a matcher on the group...
      claudeGroup(BUN, ['hook', 'stop'], { matcher: 'Bash' }),
      // ...or a timeout on the hook
      { hooks: [{ args: ['hook', 'stop'], command: BUN, timeout: 10, type: 'command' }] },
      // paths that merely contain "aiot"
      claudeGroup('/home/x/aiot-tools/x', ['hook', 'stop']),
      claudeGroup('/opt/aiot-tools/aiot-helper-x', ['run']),
      // our binary name but not our invocation
      claudeGroup('/usr/local/bin/aiot', ['status']),
      claudeGroup('/usr/local/bin/aiotool', ['hook', 'stop']),
      { command: ['bun', 'run', 'lint'], type: 'command' },
      { command: ['/aiot-tools/x', 'hook', 'stop'], type: 'command' },
      { command: [BUN, 'hook', 'stop'], timeout: 5, type: 'command' },
      { hooks: [{ command: "bash '/home/x/.claude/hooks/herdr-agent-state.sh' session" }] },
      'not-an-object',
    ];
    const before = JSON.stringify(foreign);
    expect(JSON.stringify(stripOwnedEntries(foreign))).toBe(before);
    expect(JSON.stringify(foreign)).toBe(before); // input not mutated either
  });

  it('removes only our hook from a mixed group', () => {
    const group = {
      hooks: [
        { command: 'my-tool', type: 'command' },
        { args: ['hook', 'stop'], command: LAUNCHER, type: 'command' },
      ],
      matcher: '*',
    };
    expect(stripOwnedEntries([group])).toEqual([
      { hooks: [{ command: 'my-tool', type: 'command' }], matcher: '*' },
    ]);
  });
});

// ── Self-heal: N leaked groups → exactly one correct group ────────────────────

const HERDR_CLAUDE = {
  hooks: [
    {
      command: "bash '/home/x/.claude/hooks/herdr-agent-state.sh' session",
      timeout: 10,
      type: 'command',
    },
  ],
  matcher: '*',
};
const HERDR_CODEX = {
  hooks: [
    { command: "bash '/home/x/.codex/herdr-agent-state.sh' session", timeout: 10, type: 'command' },
  ],
};

/** The events an adapter wires, discovered from a clean apply (not hard-coded). */
function wiredEvents(agent: string, rel: string): string[] {
  const path = join(tmpHome, rel);
  const result = cfgFor(agent).apply?.(LAUNCHER);
  expect(result).toBeTruthy();
  const events = Object.keys(readHooks(path));
  rmSync(path, { force: true });
  rmSync(`${path}.aiot-backup`, { force: true });
  return events;
}

describe('claude-code — leaked bun groups', () => {
  const REL = '.claude/settings.json';

  function leakedSettings(events: string[]): { hooks: Hooks } {
    const hooks: Hooks = {};
    for (const event of events) {
      hooks[event] = [];
      for (let i = 0; i < DUPLICATES; i++) {
        hooks[event].push({ hooks: [{ args: ['hook', 'x'], command: BUN, type: 'command' }] });
      }
    }
    hooks.SessionStart = [HERDR_CLAUDE, ...(hooks.SessionStart ?? [])];
    return { hooks };
  }

  it('re-install ends with exactly one group per event and the herdr hook untouched', () => {
    mkdirSync(join(tmpHome, '.claude'), { recursive: true });
    const events = wiredEvents('claude-code', REL);
    expect(events.length).toBeGreaterThan(5);
    const { hooks } = leakedSettings(events);
    const path = write(REL, JSON.stringify({ hooks, theme: 'dark' }));
    expect(Object.values(hooks).flat()).toHaveLength(events.length * DUPLICATES + 1);

    expect(cfgFor('claude-code').apply?.(LAUNCHER)).toBeTruthy();

    const after = readHooks(path);
    for (const event of events) {
      const ours = after[event]?.filter((g) => JSON.stringify(g).includes(LAUNCHER)) ?? [];
      expect(ours).toHaveLength(1);
      expect(JSON.stringify(after[event])).not.toContain(BUN);
    }
    // Foreign hook: same bytes, still first in SessionStart, nothing else foreign.
    expect(JSON.stringify(after.SessionStart?.[0])).toBe(JSON.stringify(HERDR_CLAUDE));
    expect(after.SessionStart).toHaveLength(2);
    expect(JSON.parse(readFileSync(path, 'utf8')).theme).toBe('dark');

    // Idempotent from here on.
    const once = readFileSync(path, 'utf8');
    cfgFor('claude-code').apply?.(LAUNCHER);
    expect(readFileSync(path, 'utf8')).toBe(once);
  });

  it('uninstall removes every one of ours, legacy included, and leaves the herdr hook', () => {
    mkdirSync(join(tmpHome, '.claude'), { recursive: true });
    const events = wiredEvents('claude-code', REL);
    const path = write(REL, JSON.stringify({ hooks: leakedSettings(events).hooks }));
    // Mix in a current-form group too.
    cfgFor('claude-code').apply?.(LAUNCHER);

    expect(cfgFor('claude-code').remove?.()).toBe(true);

    const after = readHooks(path);
    expect(Object.keys(after)).toEqual(['SessionStart']);
    expect(after.SessionStart).toEqual([HERDR_CLAUDE]);
  });

  it('uninstall repairs a file that holds ONLY leaked bun groups', () => {
    mkdirSync(join(tmpHome, '.claude'), { recursive: true });
    const events = wiredEvents('claude-code', REL);
    const only: Hooks = {};
    for (const event of events) {
      only[event] = [{ hooks: [{ args: ['hook', 'x'], command: BUN, type: 'command' }] }];
    }
    const path = write(REL, JSON.stringify({ hooks: only }));
    cfgFor('claude-code').remove?.();
    expect(readHooks(path)).toEqual({});
  });
});

describe('codex — leaked bun groups (hooks.json path)', () => {
  const REL = '.codex/hooks.json';

  function enableHooks(): void {
    write('.codex/config.toml', '[features]\nhooks = true\n');
  }

  it('re-install heals to one group per event; the herdr hook is untouched', () => {
    enableHooks();
    const events = wiredEvents('codex', REL);
    expect(events.length).toBeGreaterThan(3);
    const hooks: Hooks = {};
    for (const event of events) {
      hooks[event] = [];
      for (let i = 0; i < DUPLICATES; i++) {
        hooks[event].push({ command: [BUN, 'hook', 'stop', '--agent', 'codex'], type: 'command' });
      }
    }
    hooks.SessionStart = [HERDR_CODEX, ...(hooks.SessionStart ?? [])];
    const path = write(REL, JSON.stringify({ hooks }));

    expect(cfgFor('codex').apply?.(LAUNCHER)).toBeTruthy();

    const after = readHooks(path);
    for (const event of events) {
      const ours = after[event]?.filter((e) => JSON.stringify(e).includes(LAUNCHER)) ?? [];
      expect(ours).toHaveLength(1);
      expect(JSON.stringify(after[event])).not.toContain(BUN);
    }
    expect(JSON.stringify(after.SessionStart?.[0])).toBe(JSON.stringify(HERDR_CODEX));
    expect(after.SessionStart).toHaveLength(2);
  });

  it('uninstall removes all of ours and leaves the herdr hook', () => {
    enableHooks();
    const events = wiredEvents('codex', REL);
    const hooks: Hooks = {};
    for (const event of events) {
      hooks[event] = Array.from({ length: DUPLICATES }, () => ({
        command: [BUN, 'hook', 'stop', '--agent', 'codex'],
        type: 'command',
      }));
    }
    hooks.SessionStart = [HERDR_CODEX, ...(hooks.SessionStart ?? [])];
    const path = write(REL, JSON.stringify({ hooks }));
    cfgFor('codex').apply?.(LAUNCHER);

    expect(cfgFor('codex').remove?.()).toBe(true);

    expect(readHooks(path)).toEqual({ SessionStart: [HERDR_CODEX] });
  });
});

describe('gemini-cli — ownership', () => {
  const REL = '.gemini/settings.json';

  it('heals leaked bun entries and leaves look-alikes alone', () => {
    mkdirSync(join(tmpHome, '.gemini'), { recursive: true });
    const events = wiredEvents('gemini-cli', REL);
    const lookalikes = [
      { hooks: [{ command: '/home/x/aiot-tools/lint', name: 'my-aiot-lint', type: 'command' }] },
      { hooks: [{ command: 'node /opt/aiot-tools/x.js', name: 'lint', type: 'command' }] },
    ];
    const hooks: Hooks = {};
    for (const event of events) {
      hooks[event] = Array.from({ length: DUPLICATES }, () => ({
        hooks: [
          {
            command: `${JSON.stringify(BUN)} hook stop --agent gemini-cli`,
            name: 'aiot-stop',
            timeout: 5000,
            type: 'command',
          },
        ],
      }));
    }
    hooks[events[0] as string] = [...lookalikes, ...(hooks[events[0] as string] ?? [])];
    const path = write(REL, JSON.stringify({ hooks }));

    cfgFor('gemini-cli').apply?.(LAUNCHER);

    const after = readHooks(path);
    for (const event of events) {
      expect(JSON.stringify(after[event])).not.toContain(BUN);
      const ours = (after[event] ?? []).filter((g) => JSON.stringify(g).includes(LAUNCHER));
      expect(ours).toHaveLength(1);
    }
    expect((after[events[0] as string] ?? []).slice(0, 2)).toEqual(lookalikes);
  });
});

// ── Agents that overwrite a whole file never see a bun path ───────────────────

describe('whole-file agents — nothing is written from the Bun runtime', () => {
  it('refuses for every registered agent (guard is in runInstall, ahead of every apply)', async () => {
    for (const dir of [
      '.claude',
      '.codex',
      '.gemini',
      '.copilot',
      '.pi/agent/extensions',
      '.omp/agent/hooks',
      '.config/opencode/plugin',
    ]) {
      mkdirSync(join(tmpHome, dir), { recursive: true });
    }
    const exit = await runInstall(
      ['--force', '--yes', '--no-start'],
      claudeCodeAdapter,
      () => ({ exitCode: 0 }),
      tmpHome,
      process.execPath,
    );
    expect(exit).toBe(1);
    for (const rel of [
      '.claude/settings.json',
      '.codex/hooks.json',
      '.codex/aiot-notify.sh',
      '.gemini/settings.json',
      '.copilot/hooks/aiot.json',
      '.pi/agent/extensions/telemetry.ts',
      '.omp/agent/hooks/telemetry.ts',
      '.config/opencode/plugin/telemetry.ts',
    ]) {
      expect(existsSync(join(tmpHome, rel))).toBe(false);
    }
  });
});
