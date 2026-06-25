import Link from 'next/link';
import type { ReactNode } from 'react';
import { FrictionBadge } from '@/components/me/FrictionBadge';
import { StatusBadge } from '@/components/me/StatusBadge';
import { type ShapeLabel, shapeBadge } from '@/lib/effectiveness';
import type { SessionDetail } from '@/lib/sessions-queries';

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
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <h1 className="font-display text-xl font-semibold tracking-tight text-text">
            {session.repoName ?? 'Unknown repo'}
          </h1>
          <StatusBadge status={session.status} />
        </div>
        <div className="flex flex-wrap gap-3 text-xs text-text-3 font-mono">
          {ownerLabel && <span>{ownerLabel}</span>}
          {session.branch && <span>branch: {session.branch}</span>}
          {session.commitSha && <span>commit: {session.commitSha.slice(0, 7)}</span>}
          <span>started: {session.startedAt.toLocaleString()}</span>
          {session.endedAt && <span>ended: {session.endedAt.toLocaleString()}</span>}
        </div>
        <div className="flex flex-wrap items-start gap-2 pt-0.5">
          {session.shapeLabel && (
            <span
              className={`inline-flex items-center rounded px-2 py-1 text-xs ${shapeBadge(
                session.shapeLabel as ShapeLabel,
              )}`}
            >
              {session.shapeLabel}
            </span>
          )}
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
        <span className="text-sm font-mono text-text-2">${session.costUsd.toFixed(4)}</span>
        {extra}
        {transcriptHref && (
          <Link
            href={transcriptHref}
            className="rounded-lg border border-border px-3 py-1.5 text-xs text-text-2 hover:border-accent hover:text-accent transition-colors"
          >
            {transcriptLabel}
          </Link>
        )}
      </div>
    </div>
  );
}
