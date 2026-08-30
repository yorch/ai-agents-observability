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
      clearEscTimer();
    }

    // Multi-byte characters and ANSI escape sequences can be split across
    // `data` events, so we buffer input and process only complete sequences.
    let buffer = '';
    // Timer for a pending escape sequence that hasn't completed yet. If no
    // more data arrives within ~100ms, treat it as a standalone ESC (abort).
    let escTimer: ReturnType<typeof setTimeout> | null = null;

    function clearEscTimer(): void {
      if (escTimer !== null) {
        clearTimeout(escTimer);
        escTimer = null;
      }
    }

    /** Start (or reset) the pending-escape timer. Called whenever the buffer
     *  begins with ESC but the sequence isn't complete yet. */
    function ensureEscTimer(): void {
      if (escTimer !== null) {
        return;
      }
      escTimer = setTimeout(() => {
        escTimer = null;
        // If the buffer still starts with an incomplete escape sequence,
        // treat it as a standalone ESC (abort).
        if (buffer.charCodeAt(0) === 0x1b) {
          buffer = '';
          abort();
        }
      }, 100);
    }

    function abort(): void {
      cleanup();
      clearEscTimer();
      // Clear the list lines.
      stdout.write(`${CSI}${items.length}A`);
      for (let i = 0; i < items.length; i++) {
        stdout.write(`${CLEAR_LINE}\n`);
      }
      stdout.write(`${CSI}${items.length}A`);
      resolve(null);
    }

    function confirm(): void {
      cleanup();
      clearEscTimer();
      // Clear the list lines.
      stdout.write(`${CSI}${items.length}A`);
      for (let i = 0; i < items.length; i++) {
        stdout.write(`${CLEAR_LINE}\n`);
      }
      stdout.write(`${CSI}${items.length}A`);
      const selected = items.filter((_, i) => checked[i] ?? false).map((item) => item.value);
      resolve(selected);
    }

    function processBuffer(): void {
      // Loop: we may complete several short sequences from one data event.
      while (buffer.length > 0) {
        // Ctrl-C — always abort immediately.
        if (buffer.charCodeAt(0) === 0x03) {
          buffer = buffer.slice(1);
          abort();
          return;
        }

        // Escape sequence: CSI (`ESC [` ...). Wait until we have at least 3
        // bytes and the sequence terminates with a letter.
        if (buffer.startsWith(CSI)) {
          if (buffer.length < 3) {
            // Not enough bytes yet — wait for more data (or the esc timer).
            ensureEscTimer();
            return;
          }
          // Find the terminating letter (0x40–0x7E) that closes a CSI sequence.
          const end = buffer.slice(2).search(/[\x40-\x7E]/);
          if (end === -1) {
            // No terminator yet — wait for more data.
            ensureEscTimer();
            return;
          }
          const seq = buffer.slice(0, 3 + end);
          buffer = buffer.slice(3 + end);
          clearEscTimer();

          // Arrow up
          if (seq === `${CSI}A` || seq === `${CSI}1;2A`) {
            cursor = (cursor - 1 + items.length) % items.length;
            render();
            continue;
          }
          // Arrow down
          if (seq === `${CSI}B` || seq === `${CSI}1;2B`) {
            cursor = (cursor + 1) % items.length;
            render();
            continue;
          }
          // Unknown CSI sequence — ignore.
          continue;
        }

        // Lone ESC with nothing after — wait briefly; if no more data
        // arrives, treat it as a standalone abort.
        if (buffer === ESC) {
          ensureEscTimer();
          return;
        }

        // ESC followed by something that isn't `[` — treat as standalone ESC
        // (abort) and leave the rest in the buffer for the next pass.
        if (buffer.charCodeAt(0) === 0x1b) {
          buffer = buffer.slice(1);
          abort();
          return;
        }

        // Regular character — process immediately.
        const ch = buffer[0] ?? '';
        buffer = buffer.slice(1);
        clearEscTimer();

        // q — abort
        if (ch === 'q') {
          abort();
          return;
        }
        // Enter — confirm selection
        if (ch === '\r' || ch === '\n') {
          confirm();
          return;
        }
        // k — arrow up
        if (ch === 'k') {
          cursor = (cursor - 1 + items.length) % items.length;
          render();
          continue;
        }
        // j — arrow down
        if (ch === 'j') {
          cursor = (cursor + 1) % items.length;
          render();
          continue;
        }
        // Space — toggle current item
        if (ch === ' ') {
          checked[cursor] = !checked[cursor];
          render();
          continue;
        }
        // 'a' — toggle all
        if (ch === 'a') {
          const allOn = checked.every((c) => c);
          for (let i = 0; i < checked.length; i++) {
            checked[i] = !allOn;
          }
          render();
        }
        // Unknown character — ignore.
      }
    }

    function onData(data: string): void {
      buffer += data;
      // Cap buffer to prevent unbounded growth from incomplete sequences.
      if (buffer.length > 64) {
        buffer = '';
        abort();
        return;
      }
      processBuffer();
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
