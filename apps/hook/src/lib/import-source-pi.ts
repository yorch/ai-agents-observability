import { type Dirent, existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Event } from '@ai-agents-observability/schemas';
import type { HookAdapter } from '../adapters';
import { ompAdapter } from '../adapters/omp';
import { piAdapter } from '../adapters/pi';
import { filterImportedEvents, importedEvent, record, stringValue } from './import-events';
import type { HistoricalSession, ImportSource } from './import-source';
import { sessionUuid } from './session-id';

function sessionRoots(agent: 'pi' | 'omp'): string[] {
  if (agent === 'pi') {
    const home = process.env.PI_HOME ?? join(homedir(), '.pi');
    return [join(home, 'agent', 'sessions')];
  }
  const homes = process.env.OMP_HOME
    ? [process.env.OMP_HOME]
    : [join(homedir(), '.omp'), join(homedir(), '.oh-omp')];
  return homes.flatMap((home) => [join(home, 'agent', 'sessions'), home]);
}

function listSessionFiles(roots: string[]): string[] {
  const files: string[] = [];
  for (const root of roots.filter(existsSync)) {
    let entries: Dirent[];
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      const path = join(root, entry.name);
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(path);
      } else if (entry.isDirectory()) {
        try {
          for (const child of readdirSync(path, { withFileTypes: true })) {
            if (child.isFile() && !child.isSymbolicLink() && child.name.endsWith('.jsonl')) {
              files.push(join(path, child.name));
            }
          }
        } catch {
          // unreadable project directory
        }
      }
    }
  }
  return [...new Set(files)].sort((a, b) => b.localeCompare(a));
}

function nativeIdFromPath(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1, -'.jsonl'.length);
  return name.slice(name.lastIndexOf('_') + 1);
}

function parseRecords(path: string): Record<string, unknown>[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const parsed = text
    .split('\n')
    .map((line) => {
      const brace = line.indexOf('{');
      if (brace < 0) {
        return null;
      }
      try {
        return record(JSON.parse(line.slice(brace)));
      } catch {
        return null;
      }
    })
    .filter((item): item is Record<string, unknown> => item !== null);

  const byId = new Map<string, Record<string, unknown>>();
  for (const item of parsed) {
    const id = stringValue(item.id);
    if (id) {
      byId.set(id, item);
    }
  }
  const last = parsed.findLast((item) => stringValue(item.id) !== null);
  const active = new Set<string>();
  let cursor = last;
  while (cursor) {
    const id = stringValue(cursor.id);
    if (!id || active.has(id)) {
      break;
    }
    active.add(id);
    const parent = stringValue(cursor.parentId);
    cursor = parent ? byId.get(parent) : undefined;
  }
  return parsed.filter((item) => {
    const id = stringValue(item.id);
    return item.type === 'session' || item.type === 'title' || !id || active.has(id);
  });
}

function synthesize(
  path: string,
  nativeSessionId: string,
  adapter: HookAdapter,
  agentType: 'PI' | 'OMP',
  since: Date | null,
): Event[] {
  const canonicalSessionId = sessionUuid(agentType, nativeSessionId);
  const source = `${agentType.toLowerCase()}-jsonl`;
  const records = parseRecords(path);
  const session = records.find((item) => item.type === 'session');
  const cwd = stringValue(session?.cwd) ?? process.cwd();
  const events: Event[] = [];
  const origins = new Map<
    string,
    { parentEventId: string; turnNumber: number; toolName: string }
  >();
  let turnNumber = 0;

  for (const item of records) {
    const type = stringValue(item.type);
    const id = stringValue(item.id) ?? `${type}:${String(item.timestamp ?? '')}`;
    const ts = item.timestamp as string | number | undefined;
    const baseRaw = { cwd, sessionId: nativeSessionId };

    if (type === 'session') {
      events.push(
        importedEvent(
          adapter,
          'session-start',
          { ...item, ...baseRaw },
          {
            cwd,
            idSeed: `${agentType}:${canonicalSessionId}:start`,
            sessionId: canonicalSessionId,
            source,
            ts,
          },
        ),
      );
      continue;
    }

    const message = record(item.message);
    const role = stringValue(message?.role);
    if (type === 'message' && role === 'user') {
      events.push(
        importedEvent(adapter, 'user-prompt-submit', baseRaw, {
          cwd,
          idSeed: `${agentType}:${canonicalSessionId}:${id}:user`,
          sessionId: canonicalSessionId,
          source,
          ts,
        }),
      );
      continue;
    }

    if (type === 'message' && role === 'assistant' && message) {
      turnNumber += 1;
      const stopId = `${agentType}:${canonicalSessionId}:${id}:stop`;
      const parentEventId = importedEvent(
        adapter,
        'stop',
        { ...message, ...baseRaw },
        {
          cwd,
          idSeed: stopId,
          sessionId: canonicalSessionId,
          source,
          ts,
          turnNumber,
        },
      );
      const content = Array.isArray(message.content) ? message.content : [];
      const toolUseIds: string[] = [];
      for (const value of content) {
        const block = record(value);
        if (block?.type !== 'toolCall') {
          continue;
        }
        const callId = stringValue(block.id) ?? `${id}:tool:${toolUseIds.length}`;
        const toolName = stringValue(block.name) ?? 'unknown';
        toolUseIds.push(callId);
        origins.set(callId, {
          parentEventId: parentEventId.event_id,
          toolName,
          turnNumber,
        });
        const event = importedEvent(
          adapter,
          'pre-tool-use',
          { ...baseRaw, args: block.arguments, toolName },
          {
            cwd,
            idSeed: `${agentTypeSeed(agentType, canonicalSessionId, callId)}:pre`,
            parentEventId: parentEventId.event_id,
            sessionId: canonicalSessionId,
            source,
            ts,
            turnNumber,
          },
        );
        if (event.tool) {
          event.tool.tool_use_id = callId;
        }
        events.push(event);
      }
      if (toolUseIds.length > 0) {
        parentEventId.metadata.tool_use_ids = toolUseIds;
      }
      events.push(parentEventId);
      continue;
    }

    if (type === 'message' && role === 'toolResult' && message) {
      const callId = stringValue(message.toolCallId) ?? id;
      const origin = origins.get(callId);
      const event = importedEvent(
        adapter,
        'post-tool-use',
        {
          ...baseRaw,
          exitStatus: message.isError === true ? 1 : undefined,
          result: message.content,
          toolName: stringValue(message.toolName) ?? origin?.toolName ?? 'unknown',
        },
        {
          cwd,
          idSeed: `${agentTypeSeed(agentType, canonicalSessionId, callId)}:post`,
          parentEventId: origin?.parentEventId ?? null,
          sessionId: canonicalSessionId,
          source,
          ts,
          turnNumber: origin?.turnNumber,
        },
      );
      if (event.tool) {
        event.tool.tool_use_id = callId;
      }
      events.push(event);
      continue;
    }

    if (type === 'custom' && item.customType === 'session_exit') {
      events.push(
        importedEvent(adapter, 'session-end', baseRaw, {
          cwd,
          idSeed: `${agentType}:${canonicalSessionId}:end`,
          sessionId: canonicalSessionId,
          source,
          ts,
        }),
      );
    }
  }

  return filterImportedEvents(events, since);
}

function agentTypeSeed(agentType: string, sessionId: string, callId: string): string {
  return `${agentType}:${sessionId}:${callId}`;
}

function makeSource(agent: 'pi' | 'omp'): ImportSource {
  const agentType = agent === 'pi' ? 'PI' : 'OMP';
  const adapter = agent === 'pi' ? piAdapter : ompAdapter;
  return {
    agent,
    discover() {
      return listSessionFiles(sessionRoots(agent)).map((path): HistoricalSession => {
        const nativeSessionId = nativeIdFromPath(path);
        return {
          events: (since) =>
            Promise.resolve(synthesize(path, nativeSessionId, adapter, agentType, since)),
          nativeSessionId,
          prepareTranscript: () => ({ path }),
          sessionId: sessionUuid(agentType, nativeSessionId),
        };
      });
    },
  };
}

export const piImportSource = makeSource('pi');
export const ompImportSource = makeSource('omp');
