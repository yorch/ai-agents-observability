import { listSessionFiles } from './claude-projects';
import { filterImportedEvents } from './import-events';
import type { HistoricalSession, ImportSource } from './import-source';
import { createSynthCtx, entryToEvents, noteSkippedEntry } from './import-synth';
import { sessionUuid } from './session-id';
import { parseSessionFile } from './transcript-parser';

export const claudeImportSource: ImportSource = {
  agent: 'claude-code',
  discover() {
    return listSessionFiles().map(
      (file): HistoricalSession => ({
        async events(since) {
          const ctx = createSynthCtx(
            sessionUuid('CLAUDE_CODE', file.sessionId),
            process.cwd(),
            null,
          );
          const events = [];
          for await (const entry of parseSessionFile(file.path)) {
            if (entry.sessionId) {
              ctx.sessionId = sessionUuid('CLAUDE_CODE', entry.sessionId);
            }
            if (entry.cwd) {
              ctx.cwd = entry.cwd;
            }
            if (entry.version) {
              ctx.version = entry.version;
            }
            if (since && entry.timestamp && new Date(entry.timestamp) < since) {
              noteSkippedEntry(entry, ctx);
              continue;
            }
            events.push(...entryToEvents(entry, ctx));
          }
          return filterImportedEvents(events, since);
        },
        nativeSessionId: file.sessionId,
        prepareTranscript: () => ({ path: file.path }),
        sessionId: sessionUuid('CLAUDE_CODE', file.sessionId),
      }),
    );
  },
};
