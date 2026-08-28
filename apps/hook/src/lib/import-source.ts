import type { Event } from '@ai-agents-observability/schemas';
import { claudeImportSource } from './import-source-claude';
import { codexImportSource } from './import-source-codex';
import { opencodeImportSource } from './import-source-opencode';
import { ompImportSource, piImportSource } from './import-source-pi';

export const IMPORT_AGENTS = ['claude-code', 'codex', 'opencode', 'pi', 'omp'] as const;
export type ImportAgent = (typeof IMPORT_AGENTS)[number];

export type PreparedTranscript = {
  cleanup?: () => void;
  path: string;
};

export type HistoricalSession = {
  events(since: Date | null): Promise<Event[]>;
  nativeSessionId: string;
  prepareTranscript(): PreparedTranscript | null;
  sessionId: string;
};

export type ImportSource = {
  agent: ImportAgent;
  discover(): HistoricalSession[];
};

const SOURCES: Record<ImportAgent, ImportSource> = {
  'claude-code': claudeImportSource,
  codex: codexImportSource,
  omp: ompImportSource,
  opencode: opencodeImportSource,
  pi: piImportSource,
};

export function importSource(agent: string): ImportSource | null {
  return SOURCES[agent as ImportAgent] ?? null;
}
