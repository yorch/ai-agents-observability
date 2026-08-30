import { describe, expect, it } from 'bun:test';

import type { CheckboxItem } from './prompt';
import { checkboxPrompt, isInteractive } from './prompt';

// ── non-TTY fallback ──────────────────────────────────────────────────────────
//
// checkboxPrompt returns all pre-selected items when stdin is not a TTY.
// Under `bun test`, stdin is typically not a TTY, so this exercises the
// non-interactive fallback path directly.

const items: CheckboxItem[] = [
  { label: 'Claude Code', selected: true, value: 'claude-code' },
  { label: 'Codex', selected: false, value: 'codex' },
  { label: 'Gemini CLI', selected: true, value: 'gemini-cli' },
];

// Skip these tests when stdin is a real TTY — the non-interactive fallback
// path is only reachable when stdin is not a TTY.
const nonTtyOnly = process.stdin.isTTY ? it.skip : it;

describe('checkboxPrompt — non-TTY fallback', () => {
  nonTtyOnly('returns all pre-selected items when stdin is not a TTY', async () => {
    const selected = await checkboxPrompt(items);
    expect(selected).not.toBeNull();
    expect(selected).toEqual(['claude-code', 'gemini-cli']);
  });

  nonTtyOnly('returns an empty array when no items are pre-selected', async () => {
    const noneSelected: CheckboxItem[] = [
      { label: 'A', selected: false, value: 'a' },
      { label: 'B', selected: false, value: 'b' },
    ];
    const selected = await checkboxPrompt(noneSelected);
    expect(selected).not.toBeNull();
    expect(selected).toEqual([]);
  });

  nonTtyOnly('returns all items when every item is pre-selected', async () => {
    const allSelected: CheckboxItem[] = [
      { label: 'A', selected: true, value: 'a' },
      { label: 'B', selected: true, value: 'b' },
    ];
    const selected = await checkboxPrompt(allSelected);
    expect(selected).not.toBeNull();
    expect(selected).toEqual(['a', 'b']);
  });
});

describe('isInteractive', () => {
  it('returns a boolean reflecting stdin TTY status', () => {
    expect(typeof isInteractive()).toBe('boolean');
    expect(isInteractive()).toBe(Boolean(process.stdin.isTTY));
  });
});
