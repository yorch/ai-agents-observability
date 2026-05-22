import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { TranscriptViewer } from '../../../../../components/me/TranscriptViewer';
import { currentUser } from '../../../../../lib/auth';
import { getSession } from '../../../../../lib/sessions-queries';

export const dynamic = 'force-dynamic';

type PageParams = { id: string };

export default async function TranscriptPage({ params }: { params: Promise<PageParams> }) {
  const user = await currentUser();
  if (!user) {
    redirect('/login');
  }

  const { id } = await params;
  const session = await getSession(user.id, id);
  if (!session) {
    notFound();
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href={`/me/sessions/${id}`} className="text-sm text-white/50 hover:text-white">
          ← Session
        </Link>
      </div>

      <div>
        <h1 className="text-xl font-semibold">Transcript</h1>
        <p className="mt-1 text-sm text-white/50">
          {session.repoName ?? 'Unknown repo'} · {session.startedAt.toLocaleString()}
        </p>
      </div>

      {!session.transcriptS3Key ? (
        <div className="rounded-lg border border-white/10 bg-white/5 p-8 text-center">
          <p className="text-sm text-white/50">No transcript available for this session.</p>
        </div>
      ) : (
        <TranscriptViewer sessionId={id} />
      )}
    </div>
  );
}
