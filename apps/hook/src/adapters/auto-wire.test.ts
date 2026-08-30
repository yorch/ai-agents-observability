import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AdapterInstallConfig } from './index';
import { ADAPTERS } from './index';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Get an adapter's install config, throwing if the adapter is missing (test-only). */
function cfgFor(key: string): AdapterInstallConfig {
  const adapter = ADAPTERS[key];
  if (!adapter) {
    throw new Error(`Adapter ${key} not found in ADAPTERS`);
  }
  return adapter.installConfig();
}

let tmpHome: string;
let origHome: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'aiot-autowire-test-'));
  origHome = process.env.HOME;
  process.env.HOME = tmpHome;
});

afterEach(() => {
  if (origHome !== undefined) {
    process.env.HOME = origHome;
  } else {
    delete process.env.HOME;
  }
  rmSync(tmpHome, { force: true, recursive: true });
});

const BIN = '/usr/local/bin/aiot';

/** Create a directory under the temp home. */
function mkdir(path: string): void {
  mkdirSync(join(tmpHome, path), { recursive: true });
}

/** Write a file under the temp home. */
function writeFile(relPath: string, content: string): void {
  const fullPath = join(tmpHome, relPath);
  mkdirSync(join(fullPath, '..'), { recursive: true });
  writeFileSync(fullPath, content, 'utf8');
}

/** Read a JSON file under the temp home, or null if absent. */
function readJson(relPath: string): unknown {
  const fullPath = join(tmpHome, relPath);
  if (!existsSync(fullPath)) {
    return null;
  }
  return JSON.parse(readFileSync(fullPath, 'utf8'));
}

/** Check if a file exists under the temp home. */
function exists(relPath: string): boolean {
  return existsSync(join(tmpHome, relPath));
}

// ── Claude Code ───────────────────────────────────────────────────────────────

describe('claude-code auto-wire', () => {
  const cfg = () => cfgFor('claude-code');

  it('detects when ~/.claude exists', () => {
    expect(cfg().detect?.()).toBe(false);
    mkdir('.claude');
    expect(cfg().detect?.()).toBe(true);
  });

  it('writes hooks into settings.json', () => {
    mkdir('.claude');
    const result = cfg().apply?.(BIN);
    expect(result).toBeTruthy();
    const settings = readJson('.claude/settings.json') as {
      hooks: Record<string, { hooks: { command: string; args: string[]; type: string }[] }[]>;
    };
    expect(settings.hooks).toBeDefined();
    // Should have entries for multiple hook kinds
    expect(Object.keys(settings.hooks).length).toBeGreaterThan(0);
    // Each event group should have at least one entry referencing our binary
    for (const entries of Object.values(settings.hooks)) {
      const commands = entries.flatMap((e) => e.hooks.map((h) => h.command));
      expect(commands).toContain(BIN);
    }
  });

  it('preserves existing user hooks', () => {
    mkdir('.claude');
    writeFile(
      '.claude/settings.json',
      JSON.stringify({
        hooks: {
          PreToolUse: [{ command: 'my-tool', type: 'command' }],
        },
        theme: 'dark',
      }),
    );
    cfg().apply?.(BIN);
    const settings = readJson('.claude/settings.json') as {
      hooks: Record<string, unknown[]>;
      theme: string;
    };
    // User's PreToolUse hook should still be there
    expect(settings.hooks.PreToolUse).toContainEqual({ command: 'my-tool', type: 'command' });
    // User's theme should be preserved
    expect(settings.theme).toBe('dark');
  });

  it('creates a backup before first modification', () => {
    mkdir('.claude');
    writeFile('.claude/settings.json', JSON.stringify({ theme: 'dark' }));
    cfg().apply?.(BIN);
    expect(exists('.claude/settings.json.aiot-backup')).toBe(true);
    const backup = readJson('.claude/settings.json.aiot-backup') as { theme: string };
    expect(backup.theme).toBe('dark');
  });

  it('does not overwrite an existing backup', () => {
    mkdir('.claude');
    writeFile('.claude/settings.json', JSON.stringify({ theme: 'dark' }));
    cfg().apply?.(BIN);
    // Modify and apply again
    writeFile('.claude/settings.json', JSON.stringify({ theme: 'light' }));
    cfg().apply?.(BIN);
    // Backup should still have the original content
    const backup = readJson('.claude/settings.json.aiot-backup') as { theme: string };
    expect(backup.theme).toBe('dark');
  });

  it('is idempotent — applying twice does not duplicate entries', () => {
    mkdir('.claude');
    cfg().apply?.(BIN);
    cfg().apply?.(BIN);
    const settings = readJson('.claude/settings.json') as {
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    };
    for (const [, entries] of Object.entries(settings.hooks)) {
      // Each event should have exactly one aiot entry (nested in hooks[].command)
      const aiotCommands = entries.flatMap((e) =>
        e.hooks.filter((h) => h.command === BIN).map((h) => h.command),
      );
      expect(aiotCommands).toHaveLength(1);
    }
  });

  it('removes only aiot entries on uninstall', () => {
    mkdir('.claude');
    writeFile(
      '.claude/settings.json',
      JSON.stringify({
        hooks: {
          PreToolUse: [{ command: 'my-tool', type: 'command' }],
        },
      }),
    );
    cfg().apply?.(BIN);
    cfg().remove?.();
    const settings = readJson('.claude/settings.json') as {
      hooks: Record<string, unknown[]>;
    };
    // User's hook should remain
    expect(settings.hooks.PreToolUse).toContainEqual({ command: 'my-tool', type: 'command' });
    // No aiot entries should remain
    for (const entries of Object.values(settings.hooks)) {
      for (const entry of entries) {
        const e = entry as { command?: string };
        expect(e.command).not.toBe(BIN);
      }
    }
  });

  it('handles missing settings.json gracefully on remove', () => {
    mkdir('.claude');
    expect(cfg().remove?.()).toBe(true);
  });
});

// ── Gemini CLI ────────────────────────────────────────────────────────────────

describe('gemini-cli auto-wire', () => {
  const cfg = () => cfgFor('gemini-cli');

  it('detects when ~/.gemini exists', () => {
    expect(cfg().detect?.()).toBe(false);
    mkdir('.gemini');
    expect(cfg().detect?.()).toBe(true);
  });

  it('writes hooks into settings.json', () => {
    mkdir('.gemini');
    const result = cfg().apply?.(BIN);
    expect(result).toBeTruthy();
    const settings = readJson('.gemini/settings.json');
    expect(settings).toBeDefined();
  });

  it('preserves existing user hooks', () => {
    mkdir('.gemini');
    writeFile(
      '.gemini/settings.json',
      JSON.stringify({
        hooks: {
          PreToolUse: [{ command: 'my-tool', type: 'command' }],
        },
      }),
    );
    cfg().apply?.(BIN);
    const settings = readJson('.gemini/settings.json') as {
      hooks: Record<string, unknown[]>;
    };
    expect(settings.hooks.PreToolUse).toContainEqual({ command: 'my-tool', type: 'command' });
  });

  it('is idempotent', () => {
    mkdir('.gemini');
    cfg().apply?.(BIN);
    cfg().apply?.(BIN);
    const settings = readJson('.gemini/settings.json') as {
      hooks: Record<string, { hooks: { command: string; name: string }[] }[]>;
    };
    for (const entries of Object.values(settings.hooks)) {
      // Each event should have exactly one aiot entry (nested, identified by name prefix)
      const aiotNames = entries.flatMap((e) =>
        e.hooks.filter((h) => h.name.startsWith('aiot-')).map((h) => h.name),
      );
      expect(aiotNames).toHaveLength(1);
    }
  });

  it('removes only aiot entries', () => {
    mkdir('.gemini');
    writeFile(
      '.gemini/settings.json',
      JSON.stringify({
        hooks: {
          PreToolUse: [{ command: 'my-tool', type: 'command' }],
        },
      }),
    );
    cfg().apply?.(BIN);
    cfg().remove?.();
    const settings = readJson('.gemini/settings.json') as {
      hooks: Record<string, unknown[]>;
    };
    expect(settings.hooks.PreToolUse).toContainEqual({ command: 'my-tool', type: 'command' });
  });
});

// ── Copilot ───────────────────────────────────────────────────────────────────

describe('copilot auto-wire', () => {
  const cfg = () => cfgFor('copilot');

  it('detects when ~/.copilot exists', () => {
    expect(cfg().detect?.()).toBe(false);
    mkdir('.copilot');
    expect(cfg().detect?.()).toBe(true);
  });

  it('writes a dedicated hook file', () => {
    mkdir('.copilot');
    const result = cfg().apply?.(BIN);
    expect(result).toBeTruthy();
    expect(exists('.copilot/hooks/aiot.json')).toBe(true);
    const data = readJson('.copilot/hooks/aiot.json') as {
      hooks: Record<string, unknown[]>;
      version: number;
    };
    expect(data.version).toBe(1);
    expect(data.hooks).toBeDefined();
  });

  it('removes the hook file on uninstall', () => {
    mkdir('.copilot');
    cfg().apply?.(BIN);
    expect(exists('.copilot/hooks/aiot.json')).toBe(true);
    cfg().remove?.();
    expect(exists('.copilot/hooks/aiot.json')).toBe(false);
  });
});

// ── Pi ────────────────────────────────────────────────────────────────────────

describe('pi auto-wire', () => {
  const cfg = () => cfgFor('pi');

  it('detects when ~/.pi exists', () => {
    expect(cfg().detect?.()).toBe(false);
    mkdir('.pi');
    expect(cfg().detect?.()).toBe(true);
  });

  it('writes a TypeScript extension file', () => {
    mkdir('.pi/agent/extensions');
    const result = cfg().apply?.(BIN);
    expect(result).toBeTruthy();
    expect(exists('.pi/agent/extensions/telemetry.ts')).toBe(true);
  });

  it('removes the extension file on uninstall', () => {
    mkdir('.pi/agent/extensions');
    cfg().apply?.(BIN);
    expect(exists('.pi/agent/extensions/telemetry.ts')).toBe(true);
    cfg().remove?.();
    expect(exists('.pi/agent/extensions/telemetry.ts')).toBe(false);
  });
});

// ── OMP ───────────────────────────────────────────────────────────────────────

describe('omp auto-wire', () => {
  const cfg = () => cfgFor('omp');

  it('detects when ~/.omp exists', () => {
    expect(cfg().detect?.()).toBe(false);
    mkdir('.omp');
    expect(cfg().detect?.()).toBe(true);
  });

  it('detects when ~/.oh-omp exists', () => {
    expect(cfg().detect?.()).toBe(false);
    mkdir('.oh-omp');
    expect(cfg().detect?.()).toBe(true);
  });

  it('writes a TypeScript hook module', () => {
    mkdir('.omp/agent/hooks');
    const result = cfg().apply?.(BIN);
    expect(result).toBeTruthy();
    expect(exists('.omp/agent/hooks/telemetry.ts')).toBe(true);
  });

  it('removes the hook module on uninstall', () => {
    mkdir('.omp/agent/hooks');
    cfg().apply?.(BIN);
    expect(exists('.omp/agent/hooks/telemetry.ts')).toBe(true);
    cfg().remove?.();
    expect(exists('.omp/agent/hooks/telemetry.ts')).toBe(false);
  });
});

// ── opencode ──────────────────────────────────────────────────────────────────

describe('opencode auto-wire', () => {
  const cfg = () => cfgFor('opencode');

  it('detects when ~/.config/opencode exists', () => {
    expect(cfg().detect?.()).toBe(false);
    mkdir('.config/opencode');
    expect(cfg().detect?.()).toBe(true);
  });

  it('writes a TypeScript plugin file', () => {
    mkdir('.config/opencode/plugin');
    const result = cfg().apply?.(BIN);
    expect(result).toBeTruthy();
    expect(exists('.config/opencode/plugin/telemetry.ts')).toBe(true);
  });

  it('removes the plugin file on uninstall', () => {
    mkdir('.config/opencode/plugin');
    cfg().apply?.(BIN);
    expect(exists('.config/opencode/plugin/telemetry.ts')).toBe(true);
    cfg().remove?.();
    expect(exists('.config/opencode/plugin/telemetry.ts')).toBe(false);
  });
});

// ── Codex ─────────────────────────────────────────────────────────────────────

describe('codex auto-wire', () => {
  const cfg = () => cfgFor('codex');

  it('detects when ~/.codex exists', () => {
    expect(cfg().detect?.()).toBe(false);
    mkdir('.codex');
    expect(cfg().detect?.()).toBe(true);
  });

  it('writes either hooks.json or a notify wrapper', () => {
    mkdir('.codex');
    const result = cfg().apply?.(BIN);
    expect(result).toBeTruthy();
    // The adapter picks hooks or notify path depending on codexHooksFeatureEnabled()
    // We just verify something was written.
    const hasHooks = exists('.codex/hooks.json');
    const hasWrapper = exists('.codex/aiot-notify.sh');
    expect(hasHooks || hasWrapper).toBe(true);
  });

  it('removes aiot entries on uninstall', () => {
    mkdir('.codex');
    cfg().apply?.(BIN);
    cfg().remove?.();
    // After removal, hooks.json may still exist but should have no aiot entries
    if (exists('.codex/hooks.json')) {
      const data = readJson('.codex/hooks.json') as {
        hooks?: Record<string, unknown[]>;
      };
      if (data.hooks) {
        for (const entries of Object.values(data.hooks)) {
          for (const entry of entries) {
            const e = entry as { command?: string[] };
            if (Array.isArray(e.command)) {
              expect(e.command[0]).not.toBe(BIN);
            }
          }
        }
      }
    }
    // Wrapper should be removed
    expect(exists('.codex/aiot-notify.sh')).toBe(false);
  });
});

// ── stripOwnedEntries preserves user hooks in mixed groups ────────────────────

describe('stripOwnedEntries mixed-group preservation', () => {
  const cfg = () => cfgFor('claude-code');

  it('removes only aiot hooks from a group that has both aiot and user hooks', () => {
    mkdir('.claude');
    // Create settings with a group that has BOTH a user hook and an aiot hook
    writeFile(
      '.claude/settings.json',
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              hooks: [
                { command: 'my-user-tool', type: 'command' },
                { command: BIN, type: 'command' },
              ],
            },
          ],
        },
      }),
    );
    cfg().apply?.(BIN);
    cfg().remove?.();
    const settings = readJson('.claude/settings.json') as {
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    };
    // The user's hook should still be present in the nested array
    const preToolUse = settings.hooks.PreToolUse ?? [];
    const commands = preToolUse.flatMap((e) => e.hooks.map((h) => h.command));
    expect(commands).toContain('my-user-tool');
    // aiot's hook should be gone
    expect(commands).not.toContain(BIN);
  });
});

// ── Codex hooks.json path (lifecycle hooks) ──────────────────────────────────

describe('codex hooks.json lifecycle path', () => {
  const cfg = () => cfgFor('codex');

  it('removes aiot entries from hooks.json when hooks feature is enabled', () => {
    mkdir('.codex');
    // Enable the hooks feature so applyCodex takes the hooks.json path
    writeFile(
      '.codex/config.toml',
      '[features]\nhooks = true\n',
    );
    cfg().apply?.(BIN);
    // Verify hooks.json was written
    expect(exists('.codex/hooks.json')).toBe(true);
    // Now remove and verify aiot entries are gone
    cfg().remove?.();
    const data = readJson('.codex/hooks.json') as {
      hooks?: Record<string, unknown[]>;
    };
    if (data.hooks) {
      for (const entries of Object.values(data.hooks)) {
        for (const entry of entries) {
          const e = entry as { command?: string[] };
          if (Array.isArray(e.command)) {
            expect(e.command[0]).not.toBe(BIN);
          }
        }
      }
    }
  });
});

// ── All adapters have detect/apply/remove ─────────────────────────────────────

describe('all adapters support auto-wire', () => {
  for (const [key, adapter] of Object.entries(ADAPTERS)) {
    it(`${key} has detect, apply, and remove`, () => {
      const cfg = adapter.installConfig();
      expect(cfg.detect).toBeDefined();
      expect(cfg.apply).toBeDefined();
      expect(cfg.remove).toBeDefined();
    });
  }
});
