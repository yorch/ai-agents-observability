import { agentDisplayName } from '@ai-agents-observability/schemas';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { FrictionBadge } from '@/components/me/FrictionBadge';
import { StatusBadge } from '@/components/me/StatusBadge';
import { buttonClasses } from '@/components/ui/Button';
import { fmtDateTime, fmtDurationSec, fmtUsdSession } from '@/lib/fmt';
import type { SessionDetail } from '@/lib/sessions-queries';
import { ShapeBadge } from './shape';

export function SessionDetailHeader({
  extra,
  ownerLabel,
  session,
  transcriptHref,
  transcriptLabel = 'View transcript',
}: {
  extra?: ReactNode;
  ownerLabel?: string;
  session: SessionDetail;
  transcriptHref?: string | null;
  transcriptLabel?: string;
}) {
  // Break a long "owner/name" after the slash rather than mid-word on mobile.
  const slash = session.repoName?.indexOf('/') ?? -1;
  const repoTitle =
    session.repoName && slash > 0 ? (
      <>
        {session.repoName.slice(0, slash + 1)}
        <wbr />
        {session.repoName.slice(slash + 1)}
      </>
    ) : (
      (session.repoName ?? 'Unknown repo')
    );

  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="min-w-0 break-words font-display text-xl font-semibold tracking-tight text-text">
            {repoTitle}
          </h1>
          <StatusBadge status={session.status} />
        </div>
        <div className="flex flex-wrap gap-3 text-xs text-text-3 font-mono">
          {ownerLabel && <span>{ownerLabel}</span>}
          <span>{agentDisplayName(session.agentType)}</span>
          {session.branch && <span>branch: {session.branch}</span>}
          {session.commitSha && <span>commit: {session.commitSha.slice(0, 7)}</span>}
          <span>started: {fmtDateTime(session.startedAt)} UTC</span>
          {session.endedAt && <span>ended: {fmtDateTime(session.endedAt)} UTC</span>}
          {session.durationSeconds !== null && (
            <span>duration: {fmtDurationSec(session.durationSeconds)}</span>
          )}
        </div>
        <div className="flex flex-wrap items-start gap-2 pt-0.5">
          {session.shapeLabel && <ShapeBadge label={session.shapeLabel} />}
          <FrictionBadge
            score={session.frictionScore}
            inputs={{
              durationSeconds: session.durationSeconds,
              interruptCount: session.interruptCount,
              permissionDenyCount: session.permissionDenyCount,
              status: session.status,
              toolCallCount: session.toolCallCount,
              toolErrorCount: session.toolErrorCount,
              userMessageCount: session.userMessageCount,
            }}
          />
        </div>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        <span className="text-sm font-mono text-text-2">{fmtUsdSession(session.costUsd)}</span>
        {extra}
        {transcriptHref && (
          <Link href={transcriptHref} className={buttonClasses('secondary', 'sm')}>
            {transcriptLabel}
          </Link>
        )}
      </div>
    </div>
  );
}
