import { fmtDurationSec, fmtTokens } from '@/lib/fmt';
import type { TranscriptStats } from '@/lib/transcript-parser';

/** Wall-clock span between the first and last timestamped entries, or null. */
function spanSeconds(first?: string, last?: string): number | null {
  if (!first || !last) {
    return null;
  }
  const ms = new Date(last).getTime() - new Date(first).getTime();
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms / 1000) : null;
}

export function TranscriptStatsBar({ stats }: { stats: TranscriptStats }) {
  const duration = spanSeconds(stats.firstTimestamp, stats.lastTimestamp);
  const parts: string[] = [];

  if (stats.userTurns > 0) {
    parts.push(`${stats.userTurns.toLocaleString()} turn${stats.userTurns === 1 ? '' : 's'}`);
  }
  if (stats.toolCalls > 0) {
    parts.push(`${stats.toolCalls.toLocaleString()} tool call${stats.toolCalls === 1 ? '' : 's'}`);
  }
  if (stats.outputTokens > 0) {
    parts.push(`${fmtTokens(stats.outputTokens)} tokens out`);
  }
  if (stats.models.length > 0) {
    parts.push(stats.models.join(', '));
  }
  if (duration !== null) {
    parts.push(fmtDurationSec(duration));
  }

  if (parts.length === 0) {
    return null;
  }

  return (
    <p className="text-xs text-text-3 font-mono [overflow-wrap:anywhere]">{parts.join(' · ')}</p>
  );
}
