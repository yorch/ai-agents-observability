import type { ReactNode } from 'react';
import { ArrowLeftIcon, ArrowRightIcon } from '@/components/icons';
import { frictionBadge, shapeBadge } from '@/lib/effectiveness';
import type { SessionDetail, SessionEvent } from '@/lib/sessions-queries';

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-text-3">{label}</span>
      <span className="text-sm text-text-2 font-mono">{value}</span>
    </div>
  );
}

// Human-friendly label for the PR's last review decision (captured on the session
// from GitHub webhook context; surfaced here rather than left unused).
function reviewDecisionLabel(decision: string): ReactNode {
  const map: Record<string, { cls: string; text: string }> = {
    APPROVED: { cls: 'text-emerald-400', text: 'approved' },
    CHANGES_REQUESTED: { cls: 'text-amber-400', text: 'changes requested' },
    REVIEW_REQUIRED: { cls: 'text-text-3', text: 'review required' },
  };
  const m = map[decision];
  return m ? <span className={m.cls}>{m.text}</span> : decision;
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

function describeEvent(ev: SessionEvent): {
  color: string;
  label: ReactNode;
  sublabel?: string | undefined;
} {
  if (ev.eventType === 'SessionStart') {
    return { color: 'bg-accent', label: 'Session started' };
  }
  if (ev.eventType === 'Stop' || ev.eventType === 'SessionEnd') {
    return { color: 'bg-text-3', label: 'Session ended' };
  }
  if (ev.eventType === 'SubagentStop') {
    return {
      color: 'bg-text-3',
      label: 'Subagent finished',
      sublabel: ev.subagentType ?? undefined,
    };
  }
  if (ev.eventType === 'PreCompact') {
    return { color: 'bg-amber-400/60', label: 'Context compacted' };
  }
  if (ev.eventType === 'PreToolUse' || ev.eventType === 'PostToolUse') {
    const tool = ev.toolName ?? ev.mcpTool ?? '?';
    const denied = ev.toolWasDenied;
    const label = (
      <span className="inline-flex items-center gap-1.5">
        {ev.eventType === 'PreToolUse' ? <ArrowRightIcon size={12} /> : <ArrowLeftIcon size={12} />}
        {tool}
      </span>
    );
    const color = denied
      ? 'bg-red-400'
      : ev.eventType === 'PostToolUse'
        ? 'bg-green-500/60'
        : 'bg-accent/60';
    const sublabel = denied ? 'denied' : ev.mcpServer ? `via ${ev.mcpServer}` : undefined;
    return { color, label, sublabel };
  }
  if (ev.eventType === 'UserPromptSubmit') {
    return {
      color: 'bg-sky-400',
      label: ev.slashCommand ? `/${ev.slashCommand}` : 'User message',
    };
  }
  if (ev.eventType === 'Notification') {
    return { color: 'bg-purple-400/60', label: 'Notification' };
  }
  return { color: 'bg-text-3', label: ev.eventType, sublabel: ev.model ?? undefined };
}

export function Timeline({
  events = [],
  session,
}: {
  events?: SessionEvent[];
  session: SessionDetail;
}) {
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
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 rounded-lg border border-border bg-surface p-4">
        <Stat label="Duration" value={formatDuration(session.durationSeconds)} />
        <Stat label="Tool calls" value={session.toolCallCount} />
        <Stat label="Tool errors" value={session.toolErrorCount} />
        <Stat label="User messages" value={session.userMessageCount} />
        <Stat label="Permission prompts" value={session.permissionPromptCount} />
        <Stat label="Permission denies" value={session.permissionDenyCount} />
        <Stat
          label="Context resets"
          value={
            session.compactionCount + session.clearCount > 0 ? (
              <span>
                {session.compactionCount} compact
                {session.clearCount > 0 && (
                  <span className="text-text-3"> · {session.clearCount} clear</span>
                )}
              </span>
            ) : (
              '—'
            )
          }
        />
        <Stat
          label="Continuity"
          value={
            session.isResume ? (
              <span className="text-amber-400">resumed</span>
            ) : (
              <span className="text-text-3">fresh start</span>
            )
          }
        />
        <Stat label="Model" value={session.primaryModel ?? '—'} />
        <Stat label="OS" value={session.os ?? '—'} />
        {session.prReviewDecision && (
          <Stat label="PR review" value={reviewDecisionLabel(session.prReviewDecision)} />
        )}
        <Stat
          label="Friction"
          value={
            frictionInfo ? (
              <span className={frictionInfo.color}>
                {frictionInfo.label}{' '}
                <span className="text-text-3 text-xs">
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
          <div className="absolute left-2.5 top-0 bottom-0 w-px bg-border" />
          <div className="space-y-1">
            {events.map((ev, i) => {
              const { color, label, sublabel } = describeEvent(ev);
              const isDenied = ev.toolWasDenied;
              return (
                <div key={i} className="flex gap-3 pl-8 relative items-start py-0.5">
                  <div
                    className={`absolute left-0 top-2 h-5 w-5 rounded-full border flex items-center justify-center ${isDenied ? 'bg-red-500/15 border-red-500/40' : 'bg-surface border-border'}`}
                  >
                    <div className={`h-2 w-2 rounded-full ${color}`} />
                  </div>
                  <div className="min-w-0">
                    <span
                      className={`text-sm font-mono ${isDenied ? 'text-red-400' : 'text-text-2'}`}
                    >
                      {label}
                    </span>
                    {sublabel && <span className="ml-2 text-xs text-text-3">{sublabel}</span>}
                    <span className="ml-2 text-xs text-text-3 font-mono">
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
        <div className="relative">
          <div className="absolute left-2.5 top-0 bottom-0 w-px bg-border" />
          <div className="space-y-4">
            {milestones.map((event, i) => (
              <div key={i} className="flex gap-4 pl-8 relative">
                <div className="absolute left-0 top-1.5 h-5 w-5 rounded-full bg-accent/15 border border-accent/40 flex items-center justify-center">
                  <div className="h-2 w-2 rounded-full bg-accent" />
                </div>
                <div>
                  <p className="text-sm font-medium text-text">{event.label}</p>
                  <p className="text-xs text-text-3 font-mono">
                    {new Date(event.at).toLocaleString()}
                  </p>
                  <p className="text-xs text-text-2 mt-0.5">{event.description}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
