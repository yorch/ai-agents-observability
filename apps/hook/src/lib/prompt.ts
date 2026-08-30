// Interactive checkbox list for terminal selection.
// Hand-rolled with raw-mode stdin handling — no dependency needed.
//
// Usage:
//   const selected = await checkboxPrompt([
//     { label: 'Claude Code', value: 'claude-code', selected: true },
//     { label: 'Codex', value: 'codex', selected: true },
//   ]);
//   // selected: string[] — the values of checked items, or null if aborted.

import process from 'node:process';

export type CheckboxItem = {
  label: string;
  /** Detail shown after the label (e.g. config path). */
  detail?: string;
  /** Whether this item is pre-checked. */
  selected: boolean;
  /** The value returned if this item is checked. */
  value: string;
};

const ESC = '\x1B';
const CSI = `${ESC}[`;

// ANSI codes
const HIDE_CURSOR = `${CSI}?25l`;
const SHOW_CURSOR = `${CSI}?25h`;
const CLEAR_LINE = `${CSI}2K`;
const RESET = `${CSI}0m`;
const DIM = `${CSI}2m`;
const BOLD = `${CSI}1m`;
const GREEN = `${CSI}32m`;
const CYAN = `${CSI}36m`;

/**
 * Render an interactive checkbox list and return the selected values.
 * Returns null if the user aborts (q, Esc, or Ctrl-C).
 *
 * Requires a TTY. Callers must check `process.stdin.isTTY` before invoking.
 */
export async function checkboxPrompt(items: CheckboxItem[]): Promise<string[] | null> {
  const stdin = process.stdin;
  const stdout = process.stdout;

  if (!stdin.isTTY) {
    // Non-interactive: return all pre-selected items (caller should have
    // handled non-interactive mode before reaching here).
    return items.filter((i) => i.selected).map((i) => i.value);
  }

  let cursor = 0;
  // Work on a copy so we don't mutate the caller's array.
  const checked = items.map((i) => i.selected);

  return new Promise<string[] | null>((resolve) => {
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdout.write(HIDE_CURSOR);

    function render(): void {
      // Move cursor to the top of the list and clear each line.
      // We render the list starting from the line after the prompt header,
      // which the caller has already printed.
      const lines: string[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (!item) {
          continue;
        }
        const isCursor = i === cursor;
        const isChecked = checked[i] ?? false;
        const checkbox = isChecked ? `${GREEN}[x]${RESET}` : `${DIM}[ ]${RESET}`;
        const label = isCursor ? `${CYAN}${BOLD}${item.label}${RESET}` : item.label;
        const detail = item.detail ? `  ${DIM}${item.detail}${RESET}` : '';
        const pointer = isCursor ? `${CYAN}>${RESET} ` : '  ';
        lines.push(`${CLEAR_LINE}${pointer}${checkbox} ${label}${detail}`);
      }
      // Move up to the first line and write all lines.
      stdout.write(`${CSI}${items.length}A`);
      for (const line of lines) {
        stdout.write(`${line}\n`);
      }
    }

    // Print initial list (no cursor movement needed — we're at the bottom).
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item) {
        continue;
      }
      const isCursor = i === cursor;
      const isChecked = checked[i] ?? false;
      const checkbox = isChecked ? `${GREEN}[x]${RESET}` : `${DIM}[ ]${RESET}`;
      const label = isCursor ? `${CYAN}${BOLD}${item.label}${RESET}` : item.label;
      const detail = item.detail ? `  ${DIM}${item.detail}${RESET}` : '';
      const pointer = isCursor ? `${CYAN}>${RESET} ` : '  ';
      stdout.write(`${CLEAR_LINE}${pointer}${checkbox} ${label}${detail}\n`);
    }

    function cleanup(): void {
      stdout.write(SHOW_CURSOR);
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
    }

    function onData(data: string): void {
      const key = data;

      // Ctrl-C
      if (key === '\x03') {
        cleanup();
        // Clear the list lines.
        stdout.write(`${CSI}${items.length}A`);
        for (let i = 0; i < items.length; i++) {
          stdout.write(`${CLEAR_LINE}\n`);
        }
        stdout.write(`${CSI}${items.length}A`);
        resolve(null);
        return;
      }

      // q or Esc — abort
      if (key === 'q' || key === ESC) {
        cleanup();
        stdout.write(`${CSI}${items.length}A`);
        for (let i = 0; i < items.length; i++) {
          stdout.write(`${CLEAR_LINE}\n`);
        }
        stdout.write(`${CSI}${items.length}A`);
        resolve(null);
        return;
      }

      // Enter — confirm selection
      if (key === '\r' || key === '\n') {
        cleanup();
        // Clear the list lines.
        stdout.write(`${CSI}${items.length}A`);
        for (let i = 0; i < items.length; i++) {
          stdout.write(`${CLEAR_LINE}\n`);
        }
        stdout.write(`${CSI}${items.length}A`);
        const selected = items.filter((_, i) => checked[i]).map((i) => i.value);
        resolve(selected);
        return;
      }

      // Arrow up
      if (key === `${CSI}A` || key === 'k') {
        cursor = (cursor - 1 + items.length) % items.length;
        render();
        return;
      }

      // Arrow down
      if (key === `${CSI}B` || key === 'j') {
        cursor = (cursor + 1) % items.length;
        render();
        return;
      }

      // Space — toggle current item
      if (key === ' ') {
        checked[cursor] = !checked[cursor];
        render();
        return;
      }

      // 'a' — toggle all
      if (key === 'a') {
        const allOn = checked.every((c) => c);
        for (let i = 0; i < checked.length; i++) {
          checked[i] = !allOn;
        }
        render();
        return;
      }
    }

    stdin.on('data', onData);
  });
}

/**
 * True if stdin is a TTY (interactive terminal). Used to decide whether to
 * show the checkbox prompt or fall back to non-interactive behavior.
 */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY);
}
