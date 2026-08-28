import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { Event } from '@ai-agents-observability/schemas';

import { opencodeAdapter } from '../adapters/opencode';
import { filterImportedEvents, importedEvent, record, stringValue } from './import-events';
import type { HistoricalSession, ImportSource, PreparedTranscript } from './import-source';
import { agentStateDir } from './paths';
import { sessionUuid } from './session-id';

export type OpenCodeSessionRow = {
  directory: string;
  id: string;
  time_archived: number | null;
  time_created: number;
  time_updated: number;
};

type DataRow = {
  data: string;
  id: string;
  message_id?: string;
  time_created: number;
  time_updated: number;
};

export function opencodeDatabasePath(): string {
  const override = process.env.OPENCODE_DATA;
  if (override) {
    if (override.endsWith('.db')) {
      return override;
    }
    const inside = join(override, 'opencode.db');
    const sibling = join(dirname(override), 'opencode.db');
    return existsSync(inside) || !existsSync(sibling) ? inside : sibling;
  }
  const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
  return join(dataHome, 'opencode', 'opencode.db');
}

function readSessionRows(): OpenCodeSessionRow[] {
  const path = opencodeDatabasePath();
  if (!existsSync(path)) {
    return [];
  }
  const db = new Database(path, { readonly: true });
  try {
    return db
      .query<OpenCodeSessionRow, []>(
        'SELECT id, directory, time_created, time_updated, time_archived FROM session ORDER BY time_updated DESC, id',
      )
      .all();
  } finally {
    db.close();
  }
}

function readSessionData(sessionId: string): { messages: DataRow[]; parts: DataRow[] } {
  const db = new Database(opencodeDatabasePath(), { readonly: true });
  try {
    const messages = db
      .query<DataRow, [string]>(
        'SELECT id, time_created, time_updated, data FROM message WHERE session_id = ? ORDER BY time_created, id',
      )
      .all(sessionId);
    const parts = db
      .query<DataRow, [string]>(
        'SELECT id, message_id, time_created, time_updated, data FROM part WHERE session_id = ? ORDER BY time_created, id',
      )
      .all(sessionId);
    return { messages, parts };
  } finally {
    db.close();
  }
}

function jsonData(row: DataRow): Record<string, unknown> {
  try {
    return record(JSON.parse(row.data)) ?? {};
  } catch {
    return {};
  }
}

function timeValue(value: unknown, fallback: number): number {
  const valueRecord = record(value);
  const candidate = valueRecord?.completed ?? valueRecord?.end ?? valueRecord?.created ?? value;
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : fallback;
}

function synthesize(session: OpenCodeSessionRow, since: Date | null): Event[] {
  const { messages, parts } = readSessionData(session.id);
  const canonicalSessionId = sessionUuid('OPENCODE', session.id);
  const events: Event[] = [
    importedEvent(
      opencodeAdapter,
      'session-start',
      {
        directory: session.directory,
        sessionID: session.id,
      },
      {
        cwd: session.directory,
        idSeed: `OPENCODE:${canonicalSessionId}:start`,
        sessionId: canonicalSessionId,
        source: 'opencode-sqlite',
        ts: session.time_created,
      },
    ),
  ];
  const partsByMessage = new Map<string, DataRow[]>();
  for (const part of parts) {
    const list = partsByMessage.get(part.message_id ?? '') ?? [];
    list.push(part);
    partsByMessage.set(part.message_id ?? '', list);
  }
  let turnNumber = 0;

  for (const messageRow of messages) {
    const message = jsonData(messageRow);
    const role = stringValue(message.role);
    const messageTs = timeValue(message.time, messageRow.time_created);
    if (role === 'user') {
      events.push(
        importedEvent(
          opencodeAdapter,
          'user-prompt-submit',
          {
            directory: session.directory,
            sessionID: session.id,
          },
          {
            cwd: session.directory,
            idSeed: `OPENCODE:${canonicalSessionId}:${messageRow.id}:user`,
            sessionId: canonicalSessionId,
            source: 'opencode-sqlite',
            ts: messageTs,
          },
        ),
      );
      continue;
    }
    if (role !== 'assistant') {
      continue;
    }

    turnNumber += 1;
    const stopIdSeed = `OPENCODE:${canonicalSessionId}:${messageRow.id}:stop`;
    const stop = importedEvent(
      opencodeAdapter,
      'session-idle',
      {
        directory: session.directory,
        modelID: message.modelID,
        sessionID: session.id,
        tokens: message.tokens,
      },
      {
        cwd: session.directory,
        idSeed: stopIdSeed,
        sessionId: canonicalSessionId,
        source: 'opencode-sqlite',
        ts: timeValue(message.time, messageRow.time_updated),
        turnNumber,
      },
    );
    const toolUseIds: string[] = [];

    for (const partRow of partsByMessage.get(messageRow.id) ?? []) {
      const part = jsonData(partRow);
      if (part.type !== 'tool') {
        continue;
      }
      const state = record(part.state) ?? {};
      const stateTime = record(state.time) ?? {};
      const callId = stringValue(part.callID) ?? partRow.id;
      const toolName = stringValue(part.tool) ?? 'unknown';
      const preRaw = {
        args: state.input,
        directory: session.directory,
        sessionID: session.id,
        tool: toolName,
      };
      toolUseIds.push(callId);
      const pre = importedEvent(opencodeAdapter, 'pre-tool-use', preRaw, {
        cwd: session.directory,
        idSeed: `OPENCODE:${canonicalSessionId}:${callId}:pre`,
        parentEventId: stop.event_id,
        sessionId: canonicalSessionId,
        source: 'opencode-sqlite',
        ts: timeValue(stateTime.start, partRow.time_created),
        turnNumber,
      });
      if (pre.tool) {
        pre.tool.tool_use_id = callId;
      }
      events.push(pre);
      if (state.status === 'completed' || state.status === 'error') {
        const postRaw = {
          ...preRaw,
          duration_ms:
            typeof stateTime.start === 'number' && typeof stateTime.end === 'number'
              ? Math.max(0, Math.trunc(stateTime.end - stateTime.start))
              : undefined,
          exit_status: state.status === 'error' ? 1 : 0,
          result: state.output ?? state.error,
        };
        const post = importedEvent(opencodeAdapter, 'post-tool-use', postRaw, {
          cwd: session.directory,
          idSeed: `OPENCODE:${canonicalSessionId}:${callId}:post`,
          parentEventId: stop.event_id,
          sessionId: canonicalSessionId,
          source: 'opencode-sqlite',
          ts: timeValue(stateTime.end, partRow.time_updated),
          turnNumber,
        });
        if (post.tool) {
          post.tool.tool_use_id = callId;
        }
        events.push(post);
      }
    }
    if (toolUseIds.length > 0) {
      stop.metadata.tool_use_ids = toolUseIds;
    }
    events.push(stop);
  }

  if (session.time_archived) {
    events.push(
      importedEvent(
        opencodeAdapter,
        'session-end',
        {
          directory: session.directory,
          sessionID: session.id,
        },
        {
          cwd: session.directory,
          idSeed: `OPENCODE:${canonicalSessionId}:end`,
          sessionId: canonicalSessionId,
          source: 'opencode-sqlite',
          ts: session.time_archived,
        },
      ),
    );
  }

  return filterImportedEvents(events, since);
}

function importStagingDir(): string {
  return join(agentStateDir('opencode'), 'import');
}

function prepareTranscript(session: OpenCodeSessionRow): PreparedTranscript | null {
  const { messages, parts } = readSessionData(session.id);
  const rows = [
    ...messages.map((row) => ({ data: row.data, id: row.id, time: row.time_created })),
    ...parts.map((row) => ({ data: row.data, id: row.id, time: row.time_created })),
  ].sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
  if (rows.length === 0) {
    return null;
  }
  const dir = importStagingDir();
  mkdirSync(dir, { mode: 0o700, recursive: true });
  const path = join(dir, `${sessionUuid('OPENCODE', session.id)}.jsonl`);
  writeFileSync(path, `${rows.map((row) => row.data).join('\n')}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  return { cleanup: () => rmSync(path, { force: true }), path };
}

export const opencodeImportSource: ImportSource = {
  agent: 'opencode',
  discover() {
    rmSync(importStagingDir(), { force: true, recursive: true });
    return readSessionRows().map(
      (session): HistoricalSession => ({
        events: (since) => Promise.resolve(synthesize(session, since)),
        nativeSessionId: session.id,
        prepareTranscript: () => prepareTranscript(session),
        sessionId: sessionUuid('OPENCODE', session.id),
      }),
    );
  },
};
