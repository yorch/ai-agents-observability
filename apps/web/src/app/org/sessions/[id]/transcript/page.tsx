import Link from 'next/link';
import { notFound } from 'next/navigation';
import { TranscriptViewer } from '@/components/me/TranscriptViewer';
import { AuditAction, writeAuditLog } from '@/lib/audit';
import { requireOrgAdmin } from '@/lib/roles';
import { getSession, getSessionOrgContext } from '@/lib/sessions-queries';

export const dynamic = 'force-dynamic';

type PageParams = { id: string };

export default async function OrgTranscriptPage({ params }: { params: Promise<PageParams> }) {
  const { id } = await params;
  const { user } = await requireOrgAdmin();

  const ctx = await getSessionOrgContext(id);
  if (!ctx) {
    notFound();
  }

  const session = await getSession(ctx.ownerUserId, id);
  if (!session) {
    notFound();
  }

  const owner = ctx.displayName ?? (ctx.ownerLogin ? `@${ctx.ownerLogin}` : 'Unknown user');

  // Transcript content is opt-in per §8.2 — do not reveal content without it.
  if (!ctx.shareTranscriptsWithOrg) {
    return (
      <div className="space-y-6">
        <Link href={`/org/sessions/${id}`} className="text-sm text-white/50 hover:text-white">
          ← Session
        </Link>
        <div className="rounded-lg border border-white/10 bg-white/5 p-8 text-center">
          <p className="text-sm text-white/50">{owner} has not shared transcripts with the org.</p>
        </div>
      </div>
    );
  }

  // §8.3: audit the privileged transcript view before rendering.
  void writeAuditLog({
    action: AuditAction.view_transcript,
    actorUserId: user.id,
    targetSessionId: id,
    targetUserId: ctx.ownerUserId,
  });

  const apiUrl = `/api/org/transcripts/${id}`;

  return (
    <div className="space-y-6">
      <Link href={`/org/sessions/${id}`} className="text-sm text-white/50 hover:text-white">
        ← Session
      </Link>

      <div>
        <h1 className="text-xl font-semibold">Transcript</h1>
        <p className="mt-1 text-sm text-white/50">
          {owner} · {session.repoName ?? 'Unknown repo'} · {session.startedAt.toLocaleString()}
        </p>
      </div>

      {!session.transcriptS3Key ? (
        <div className="rounded-lg border border-white/10 bg-white/5 p-8 text-center">
          <p className="text-sm text-white/50">No transcript available for this session.</p>
        </div>
      ) : (
        <TranscriptViewer sessionId={id} apiUrl={apiUrl} />
      )}
    </div>
  );
}
