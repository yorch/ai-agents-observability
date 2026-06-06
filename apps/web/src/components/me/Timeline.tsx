import type { SessionDetail } from '@/lib/sessions-queries';

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-white/40">{label}</span>
      <span className="text-sm text-white/80">{value}</span>
    </div>
  );
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) {
    return '—';
  }
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) {
    return `${m}m ${s}s`;
  }
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return `${h}h ${rem}m`;
}

export function Timeline({ session }: { session: SessionDetail }) {
  const events = [
    {
      at: session.startedAt.toISOString(),
      description: session.repoName ? `Started in ${session.repoName}` : 'Session started',
      label: 'Session started',
    },
    session.endedAt
      ? {
          at: session.endedAt.toISOString(),
          description: session.endReason ? `End reason: ${session.endReason}` : 'Session ended',
          label: 'Session ended',
        }
      : null,
  ].filter(Boolean) as { at: string; description: string; label: string }[];

  return (
    <div className="space-y-6">
      {/* Summary stats */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 rounded-lg border border-white/10 bg-white/5 p-4">
        <Stat label="Duration" value={formatDuration(session.durationSeconds)} />
        <Stat label="Tool calls" value={session.toolCallCount} />
        <Stat label="Tool errors" value={session.toolErrorCount} />
        <Stat label="User messages" value={session.userMessageCount} />
        <Stat label="Permission prompts" value={session.permissionPromptCount} />
        <Stat label="Permission denies" value={session.permissionDenyCount} />
        <Stat label="Model" value={session.primaryModel ?? '—'} />
        <Stat label="OS" value={session.os ?? '—'} />
      </div>

      {/* Timeline events */}
      <div className="relative">
        <div className="absolute left-2.5 top-0 bottom-0 w-px bg-white/10" />
        <div className="space-y-4">
          {events.map((event, i) => (
            <div key={i} className="flex gap-4 pl-8 relative">
              <div className="absolute left-0 top-1.5 h-5 w-5 rounded-full bg-brand-500/20 border border-brand-500/40 flex items-center justify-center">
                <div className="h-2 w-2 rounded-full bg-brand-500" />
              </div>
              <div>
                <p className="text-sm font-medium">{event.label}</p>
                <p className="text-xs text-white/40">{new Date(event.at).toLocaleString()}</p>
                <p className="text-xs text-white/60 mt-0.5">{event.description}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      <p className="text-xs text-white/30 italic">
        Event-level timeline (individual tool calls, API calls) available in Phase 2.
      </p>
    </div>
  );
}
