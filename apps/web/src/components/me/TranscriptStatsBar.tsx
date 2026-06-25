import type { TranscriptStats } from '@/lib/transcript-parser';

function formatDuration(first?: string, last?: string): string | null {
  if (!first || !last) {
    return null;
  }
  const ms = new Date(last).getTime() - new Date(first).getTime();
  if (ms <= 0) {
    return null;
  }
  const mins = Math.round(ms / 60_000);
  if (mins < 1) {
    return '<1 min';
  }
  if (mins < 60) {
    return `${mins} min`;
  }
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1_000) {
    return `${Math.round(n / 1_000)}k`;
  }
  return String(n);
}

export function TranscriptStatsBar({ stats }: { stats: TranscriptStats }) {
  const duration = formatDuration(stats.firstTimestamp, stats.lastTimestamp);
  const parts: string[] = [];

  if (stats.userTurns > 0) {
    parts.push(`${stats.userTurns} turn${stats.userTurns === 1 ? '' : 's'}`);
  }
  if (stats.toolCalls > 0) {
    parts.push(`${stats.toolCalls} tool call${stats.toolCalls === 1 ? '' : 's'}`);
  }
  if (stats.outputTokens > 0) {
    parts.push(`${formatTokens(stats.outputTokens)} tokens out`);
  }
  if (stats.models.length > 0) {
    parts.push(stats.models.join(', '));
  }
  if (duration) {
    parts.push(duration);
  }

  if (parts.length === 0) {
    return null;
  }

  return <p className="text-xs text-text-3 font-mono">{parts.join(' · ')}</p>;
}
