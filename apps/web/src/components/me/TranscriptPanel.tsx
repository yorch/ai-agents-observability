import Link from 'next/link';
import type { ReactNode } from 'react';
import { ArrowLeftIcon } from '@/components/icons';
import { TranscriptViewer } from '@/components/me/TranscriptViewer';
import { EmptyState } from '@/components/ui';

export function TranscriptPanel({
  apiUrl,
  backHref,
  hasTranscript,
  notice,
  sessionId,
  subtitle,
}: {
  apiUrl?: string;
  backHref: string;
  hasTranscript: boolean;
  notice?: ReactNode;
  sessionId: string;
  subtitle: ReactNode;
}) {
  return (
    <div className="space-y-6">
      <Link
        href={backHref}
        className="inline-flex items-center gap-1 text-sm text-text-3 hover:text-accent transition-colors"
      >
        <ArrowLeftIcon /> Session
      </Link>

      <div>
        <h1 className="font-display text-xl font-semibold tracking-tight text-text">Transcript</h1>
        <p className="mt-1 text-sm text-text-2">{subtitle}</p>
        {notice}
      </div>

      {hasTranscript ? (
        <TranscriptViewer sessionId={sessionId} apiUrl={apiUrl} />
      ) : (
        <EmptyState>No transcript available for this session.</EmptyState>
      )}
    </div>
  );
}
