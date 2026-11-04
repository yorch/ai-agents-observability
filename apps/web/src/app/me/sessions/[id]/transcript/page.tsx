import { agentDisplayName } from '@ai-agents-observability/schemas';
import { notFound } from 'next/navigation';
import { TranscriptPanel } from '@/components/me/TranscriptPanel';
import { currentUser, redirectToLogin } from '@/lib/auth';
import { fmtDateTime } from '@/lib/fmt';
import { getSession } from '@/lib/sessions-queries';

export const dynamic = 'force-dynamic';

type PageParams = { id: string };

export default async function TranscriptPage({ params }: { params: Promise<PageParams> }) {
  const user = await currentUser();
  if (!user) {
    return redirectToLogin();
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
      labels={{ assistant: agentDisplayName(session.agentType), user: 'You' }}
      sessionId={id}
      subtitle={`${session.repoName ?? 'Unknown repo'} · ${fmtDateTime(session.startedAt)} UTC`}
    />
  );
}
