import Link from 'next/link';
import type { ReactNode } from 'react';
import { TranscriptViewer } from '@/components/me/TranscriptViewer';

/**
 * The "render a transcript" panel shared by the /me, /team, and /org transcript
 * pages: a back link, the heading + subtitle (and an optional notice), then
 * either the viewer or a "no transcript" placeholder. The pages own their
 * audience-specific auth/audit and any access-gating branches; this is only the
 * common presentation once access is decided.
 */
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
      <div className="flex items-center gap-3">
        <Link href={backHref} className="text-sm text-white/50 hover:text-white">
          ← Session
        </Link>
      </div>

      <div>
        <h1 className="text-xl font-semibold">Transcript</h1>
        <p className="mt-1 text-sm text-white/50">{subtitle}</p>
        {notice}
      </div>

      {hasTranscript ? (
        <TranscriptViewer sessionId={sessionId} apiUrl={apiUrl} />
      ) : (
        <div className="rounded-lg border border-white/10 bg-white/5 p-8 text-center">
          <p className="text-sm text-white/50">No transcript available for this session.</p>
        </div>
      )}
    </div>
  );
}
