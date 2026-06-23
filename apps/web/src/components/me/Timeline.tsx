import type { ReactNode } from 'react';
import { frictionBadge, shapeBadge } from '@/lib/effectiveness';
import type { SessionDetail, SessionEvent } from '@/lib/sessions-queries';

function Stat({ label, value }: { label: string; value: ReactNode }) {
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

/** Derive a human-readable label + dot color from a raw event. */
function describeEvent(ev: SessionEvent): {
  color: string;
  label: string;
  sublabel?: string | undefined;
} {
  if (ev.eventType === 'SessionStart') {
    return { color: 'bg-brand-500', label: 'Session started' };
  }
  if (ev.eventType === 'Stop' || ev.eventType === 'SessionEnd') {
    return { color: 'bg-white/40', label: 'Session ended' };
  }
  if (ev.eventType === 'SubagentStop') {
    return { color: 'bg-white/30', label: 'Subagent finished' };
  }
  if (ev.eventType === 'PreCompact') {
    return { color: 'bg-amber-400/60', label: 'Context compacted' };
  }
  if (ev.eventType === 'PreToolUse' || ev.eventType === 'PostToolUse') {
    const tool = ev.toolName ?? ev.mcpTool ?? '?';
    const denied = ev.toolWasDenied;
    const label = `${ev.eventType === 'PreToolUse' ? '→' : '←'} ${tool}`;
    const color = denied
      ? 'bg-red-400'
      : ev.eventType === 'PostToolUse'
        ? 'bg-green-500/60'
        : 'bg-brand-500/60';
    const sublabel = denied ? 'denied' : ev.mcpServer ? `via ${ev.mcpServer}` : undefined;
    return { color, label, sublabel };
  }
  if (ev.eventType === 'UserPromptSubmit' || ev.slashCommand) {
    return {
      color: 'bg-sky-400',
      label: ev.slashCommand ? `/${ev.slashCommand}` : 'User message',
    };
  }
  if (ev.eventType === 'Notification') {
    return { color: 'bg-purple-400/60', label: 'Notification' };
  }
  return { color: 'bg-white/20', label: ev.eventType, sublabel: ev.model ?? undefined };
}

export function Timeline({
  events = [],
  session,
}: {
  events?: SessionEvent[];
  session: SessionDetail;
}) {
  // Build milestone events for the top/bottom anchors
  const milestones = [
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

  const frictionScore = session.frictionScore;
  const frictionInfo = frictionScore !== null ? frictionBadge(frictionScore) : null;

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
        <Stat
          label="Friction"
          value={
            frictionInfo ? (
              <span className={frictionInfo.color}>
                {frictionInfo.label}{' '}
                <span className="text-white/30 text-xs">
                  ({((frictionScore ?? 0) * 100).toFixed(0)}%)
                </span>
              </span>
            ) : (
              '—'
            )
          }
        />
        <Stat
          label="Shape"
          value={
            session.shapeLabel ? (
              <span
                className={`text-xs px-1.5 py-0.5 rounded ${shapeBadge(session.shapeLabel as Parameters<typeof shapeBadge>[0])}`}
              >
                {session.shapeLabel}
              </span>
            ) : (
              '—'
            )
          }
        />
      </div>

      {/* Per-event timeline */}
      {events.length > 0 ? (
        <div className="relative">
          <div className="absolute left-2.5 top-0 bottom-0 w-px bg-white/10" />
          <div className="space-y-1.5">
            {events.map((ev, i) => {
              const { color, label, sublabel } = describeEvent(ev);
              const isDenied = ev.toolWasDenied;
              return (
                <div key={i} className="flex gap-3 pl-8 relative items-start py-0.5">
                  <div
                    className={`absolute left-0 top-2 h-5 w-5 rounded-full border border-white/10 flex items-center justify-center ${isDenied ? 'bg-red-500/20 border-red-500/40' : 'bg-white/5'}`}
                  >
                    <div className={`h-2 w-2 rounded-full ${color}`} />
                  </div>
                  <div className="min-w-0">
                    <span
                      className={`text-sm font-mono ${isDenied ? 'text-red-300' : 'text-white/70'}`}
                    >
                      {label}
                    </span>
                    {sublabel && <span className="ml-2 text-xs text-white/30">{sublabel}</span>}
                    <span className="ml-2 text-xs text-white/20">
                      {ev.ts.toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                      })}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        /* Fallback: show session start/end milestones only */
        <div className="relative">
          <div className="absolute left-2.5 top-0 bottom-0 w-px bg-white/10" />
          <div className="space-y-4">
            {milestones.map((event, i) => (
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
      )}
    </div>
  );
}
