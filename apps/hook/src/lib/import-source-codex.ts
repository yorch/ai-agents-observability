import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Event } from '@ai-agents-observability/schemas';

import { codexAdapter } from '../adapters/codex';
import { type CodexUsage, parseRolloutRecords, usageDelta } from './codex-rollout';
import { filterImportedEvents, importedEvent, record, stringValue } from './import-events';
import type { HistoricalSession, ImportSource } from './import-source';
import { sessionUuid } from './session-id';

const ROLLOUT_PATTERN = /^rollout-.*\.jsonl$/;
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function sessionsRoot(): string {
  return join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions');
}

function collectRollouts(dir: string, depth = 0): string[] {
  if (depth > 5 || !existsSync(dir)) {
    return [];
  }
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      continue;
    }
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectRollouts(path, depth + 1));
    } else if (entry.isFile() && ROLLOUT_PATTERN.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

function readRecords(path: string): Record<string, unknown>[] {
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try {
          return record(JSON.parse(line));
        } catch {
          return null;
        }
      })
      .filter((item): item is Record<string, unknown> => item !== null);
  } catch {
    return [];
  }
}

function timestampValue(value: unknown): string | number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) {
    return value;
  }
  return null;
}

function llmFromUsage(usage: CodexUsage): NonNullable<Event['llm']> {
  const cached = usage.cacheReadTokens + usage.cacheWriteTokens;
  return {
    cache_creation_tokens: usage.cacheWriteTokens,
    cache_read_tokens: usage.cacheReadTokens,
    cost_usd: 0,
    input_tokens: Math.max(0, usage.inputTokens - cached),
    model: usage.model ?? 'unknown',
    output_tokens: usage.outputTokens,
  };
}

function synthesize(path: string, nativeSessionId: string, since: Date | null): Event[] {
  const records = readRecords(path);
  const canonicalSessionId = sessionUuid('CODEX', nativeSessionId);
  const sessionMeta = records.find((item) => {
    const payload = record(item.payload);
    return item.type === 'session_meta' || payload?.type === 'session_meta';
  });
  const sessionPayload = record(sessionMeta?.payload) ?? sessionMeta ?? {};
  const cwd = stringValue(sessionPayload.cwd) ?? process.cwd();
  const events: Event[] = [];
  const calls = new Map<
    string,
    { input: unknown; name: string; parentEventId: string; turnNumber: number }
  >();
  let cumulative: CodexUsage | null = null;
  let previousCumulative: CodexUsage | null = null;
  let currentModel = stringValue(sessionPayload.model);
  let turnKey = 'turn-0';
  let turnNumber = 0;
  let lastTimestamp: string | number =
    timestampValue(sessionMeta?.timestamp ?? sessionPayload.timestamp) ?? statSync(path).mtimeMs;

  if (sessionMeta) {
    events.push(
      importedEvent(
        codexAdapter,
        'session-start',
        { cwd, session_id: nativeSessionId },
        {
          cwd,
          idSeed: `CODEX:${canonicalSessionId}:start`,
          sessionId: canonicalSessionId,
          source: 'codex-rollout',
          ts: lastTimestamp,
        },
      ),
    );
  }

  for (const item of records) {
    const payload = record(item.payload) ?? item;
    const outerType = stringValue(item.type) ?? '';
    const type = stringValue(payload.type) ?? outerType;
    lastTimestamp =
      timestampValue(
        item.timestamp ??
          payload.timestamp ??
          payload.completed_at ??
          payload.started_at ??
          payload.completed_at_ms ??
          payload.started_at_ms,
      ) ?? lastTimestamp;
    const ts = lastTimestamp;

    if (type === 'turn_context') {
      currentModel = stringValue(payload.model) ?? currentModel;
      turnKey = stringValue(payload.turn_id) ?? turnKey;
      continue;
    }
    if (type === 'task_started') {
      turnNumber += 1;
      turnKey = stringValue(payload.turn_id) ?? `turn-${turnNumber}`;
      continue;
    }
    if (type === 'user_message') {
      events.push(
        importedEvent(
          codexAdapter,
          'user-prompt-submit',
          { cwd, session_id: nativeSessionId },
          {
            cwd,
            idSeed: `CODEX:${canonicalSessionId}:${turnKey}:user`,
            sessionId: canonicalSessionId,
            source: 'codex-rollout',
            ts,
            turnNumber: turnNumber > 0 ? turnNumber : undefined,
          },
        ),
      );
      continue;
    }
    if (type === 'function_call' || type === 'custom_tool_call') {
      const callId = stringValue(payload.call_id) ?? stringValue(payload.id) ?? `${turnKey}:${ts}`;
      const name = stringValue(payload.name) ?? 'unknown';
      const parentEventId = importedEvent(
        codexAdapter,
        'stop',
        { cwd, session_id: nativeSessionId },
        {
          cwd,
          idSeed: `CODEX:${canonicalSessionId}:${turnKey}:stop`,
          sessionId: canonicalSessionId,
          source: 'codex-rollout',
          ts,
          turnNumber: turnNumber > 0 ? turnNumber : undefined,
        },
      ).event_id;
      calls.set(callId, {
        input: payload.arguments ?? payload.input,
        name,
        parentEventId,
        turnNumber,
      });
      const event = importedEvent(
        codexAdapter,
        'pre-tool-use',
        {
          cwd,
          session_id: nativeSessionId,
          tool_input: payload.arguments ?? payload.input,
          tool_name: name,
        },
        {
          cwd,
          idSeed: `CODEX:${canonicalSessionId}:${callId}:pre`,
          parentEventId,
          sessionId: canonicalSessionId,
          source: 'codex-rollout',
          ts,
          turnNumber: turnNumber > 0 ? turnNumber : undefined,
        },
      );
      if (event.tool) {
        event.tool.tool_use_id = callId;
      }
      events.push(event);
      continue;
    }
    if (type === 'function_call_output' || type === 'custom_tool_call_output') {
      const callId = stringValue(payload.call_id) ?? stringValue(payload.id) ?? `${turnKey}:${ts}`;
      const call = calls.get(callId);
      const event = importedEvent(
        codexAdapter,
        'post-tool-use',
        {
          cwd,
          session_id: nativeSessionId,
          tool_input: call?.input,
          tool_name: call?.name ?? 'unknown',
          tool_response: payload.output ?? payload.result,
        },
        {
          cwd,
          idSeed: `CODEX:${canonicalSessionId}:${callId}:post`,
          parentEventId: call?.parentEventId ?? null,
          sessionId: canonicalSessionId,
          source: 'codex-rollout',
          ts,
          turnNumber: call && call.turnNumber > 0 ? call.turnNumber : undefined,
        },
      );
      if (event.tool) {
        event.tool.tool_use_id = callId;
      }
      events.push(event);
      continue;
    }
    if (type === 'token_count') {
      const parsed = parseRolloutRecords([item]).cumulativeUsage;
      if (parsed) {
        cumulative = { ...parsed, model: parsed.model ?? currentModel };
      }
      continue;
    }
    if (type === 'task_complete' || type === 'turn_aborted') {
      const delta = usageDelta(previousCumulative, cumulative);
      previousCumulative = cumulative;
      const stop = importedEvent(
        codexAdapter,
        'stop',
        { cwd, session_id: nativeSessionId },
        {
          cwd,
          idSeed: `CODEX:${canonicalSessionId}:${turnKey}:stop`,
          sessionId: canonicalSessionId,
          source: 'codex-rollout',
          ts,
          turnNumber: turnNumber > 0 ? turnNumber : undefined,
        },
      );
      if (delta) {
        stop.llm = llmFromUsage(delta);
      }
      events.push(stop);
    }
  }

  return filterImportedEvents(events, since);
}

export const codexImportSource: ImportSource = {
  agent: 'codex',
  discover() {
    return collectRollouts(sessionsRoot())
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs || a.localeCompare(b))
      .flatMap((path): HistoricalSession[] => {
        const nativeSessionId = path.match(UUID_PATTERN)?.[0];
        if (!nativeSessionId) {
          return [];
        }
        return [
          {
            events: (since) => Promise.resolve(synthesize(path, nativeSessionId, since)),
            nativeSessionId,
            prepareTranscript: () => ({ path }),
            sessionId: sessionUuid('CODEX', nativeSessionId),
          },
        ];
      });
  },
};
