import { notFound, redirect } from 'next/navigation';
import { TranscriptPanel } from '@/components/me/TranscriptPanel';
import { currentUser } from '@/lib/auth';
import { getSession } from '@/lib/sessions-queries';

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
    <TranscriptPanel
      backHref={`/me/sessions/${id}`}
      hasTranscript={Boolean(session.transcriptS3Key)}
      sessionId={id}
      subtitle={`${session.repoName ?? 'Unknown repo'} · ${session.startedAt.toLocaleString()}`}
    />
  );
}
