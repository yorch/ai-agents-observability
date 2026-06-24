import Link from 'next/link';
import { notFound } from 'next/navigation';
import { TranscriptPanel } from '@/components/me/TranscriptPanel';
import { MIN_JUSTIFICATION_LENGTH, normalizeJustification } from '@/lib/audit';
import { requireOrgAdmin } from '@/lib/roles';
import { getSession, getSessionOrgContext } from '@/lib/sessions-queries';

export const dynamic = 'force-dynamic';

type PageParams = { id: string };
type SearchParams = { justification?: string };

export default async function OrgTranscriptPage({
  params,
  searchParams,
}: {
  params: Promise<PageParams>;
  searchParams: Promise<SearchParams>;
}) {
  const { id } = await params;
  // Org-admin only — viewer_aggregate must never reach an individual transcript.
  await requireOrgAdmin();

  const ctx = await getSessionOrgContext(id);
  if (!ctx) {
    notFound();
  }

  const session = await getSession(ctx.ownerUserId, id);
  if (!session) {
    notFound();
  }

  const owner = ctx.displayName ?? (ctx.ownerLogin ? `@${ctx.ownerLogin}` : 'Unknown user');

  if (!session.transcriptS3Key) {
    return (
      <TranscriptPanel
        backHref={`/org/sessions/${id}`}
        hasTranscript={false}
        sessionId={id}
        subtitle={`${owner} · ${session.repoName ?? 'Unknown repo'} · ${session.startedAt.toLocaleString()}`}
      />
    );
  }

  const justification = normalizeJustification((await searchParams).justification);
  const hasAccess = ctx.shareTranscriptsWithOrg || justification !== null;

  // §8.4: the owner has not shared with the org — require a written justification
  // before any content is requested. Submitting reloads with `?justification=…`,
  // and the API route records it on the audit row the owner can see.
  if (!hasAccess) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <Link href={`/org/sessions/${id}`} className="text-sm text-white/50 hover:text-white">
            ← Session
          </Link>
        </div>
        <div>
          <h1 className="text-xl font-semibold">Request transcript access</h1>
          <p className="mt-1 text-sm text-white/50">
            {owner} has not shared transcripts with the org. Viewing this transcript is logged and
            visible to {owner} in their own audit feed.
          </p>
        </div>
        <form method="GET" className="space-y-3 rounded-lg border border-white/10 bg-white/5 p-4">
          <label htmlFor="justification" className="block text-sm text-white/70">
            Justification (min {MIN_JUSTIFICATION_LENGTH} characters)
          </label>
          <textarea
            id="justification"
            name="justification"
            required
            minLength={MIN_JUSTIFICATION_LENGTH}
            rows={3}
            placeholder="e.g. security incident #1234 — investigating leaked credential"
            className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm"
          />
          <button
            type="submit"
            className="rounded-md bg-brand-500 px-4 py-2 text-sm font-medium hover:bg-brand-600"
          >
            View with justification
          </button>
        </form>
      </div>
    );
  }

  // The API route is the single audit point for transcript content; thread the
  // justification through so it lands on the audit row.
  const apiUrl = justification
    ? `/api/org/transcripts/${id}?justification=${encodeURIComponent(justification)}`
    : `/api/org/transcripts/${id}`;

  return (
    <TranscriptPanel
      apiUrl={apiUrl}
      backHref={`/org/sessions/${id}`}
      hasTranscript
      notice={
        justification ? (
          <p className="mt-2 text-xs text-amber-400/80">
            Accessed via justification — this view is recorded in {owner}&apos;s audit feed.
          </p>
        ) : undefined
      }
      sessionId={id}
      subtitle={`${owner} · ${session.repoName ?? 'Unknown repo'} · ${session.startedAt.toLocaleString()}`}
    />
  );
}
