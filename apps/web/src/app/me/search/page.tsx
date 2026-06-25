import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/auth';
import { MIN_QUERY_LENGTH, searchOwnTranscripts } from '@/lib/search-queries';

export const dynamic = 'force-dynamic';

export default async function MeSearchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const user = await currentUser();
  if (!user) {
    redirect('/login');
  }

  const params = await searchParams;
  const rawQuery = params.q ?? '';
  const query = rawQuery.trim();
  const page = Math.max(1, Number(params.page ?? '1') || 1);

  const tooShort = query.length > 0 && query.length < MIN_QUERY_LENGTH;
  const results =
    query.length >= MIN_QUERY_LENGTH ? await searchOwnTranscripts(user.id, query, page) : null;
  const totalPages = results ? Math.ceil(results.total / results.pageSize) : 0;

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-4 py-8">
      <div>
        <h1 className="text-2xl font-semibold">Search my transcripts</h1>
        <p className="mt-1 text-sm text-white/50">
          Full-text search across your own session transcripts.
        </p>
      </div>

      <form method="GET" className="flex gap-3">
        <input
          type="text"
          name="q"
          defaultValue={rawQuery}
          placeholder="Search your transcripts…"
          aria-label="Search your transcripts"
          className="flex-1 rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm"
        />
        <button
          type="submit"
          className="rounded-md bg-brand-500 px-4 py-2 text-sm font-medium text-bg hover:bg-brand-600"
        >
          Search
        </button>
      </form>

      {!query && <p className="text-sm text-white/40">Enter a term to search your transcripts.</p>}

      {tooShort && (
        <p className="text-sm text-yellow-300/80">
          Enter at least {MIN_QUERY_LENGTH} characters to search.
        </p>
      )}

      {results && (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white/70">
              Matches {results.total > 0 && `(${results.total} sessions)`}
            </h2>
            {totalPages > 1 && (
              <div className="flex items-center gap-2 text-sm">
                {page > 1 && (
                  <a href={buildUrl(query, page - 1)} className="text-brand-400 hover:underline">
                    ← Prev
                  </a>
                )}
                <span className="text-white/40">
                  {page} / {totalPages}
                </span>
                {page < totalPages && (
                  <a href={buildUrl(query, page + 1)} className="text-brand-400 hover:underline">
                    Next →
                  </a>
                )}
              </div>
            )}
          </div>

          {results.sessions.length === 0 ? (
            <p className="text-sm text-white/40">No matching sessions.</p>
          ) : (
            <div className="space-y-3">
              {results.sessions.map((s) => (
                <div
                  key={s.sessionId}
                  className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-2"
                >
                  <div className="flex items-center gap-2 text-xs text-white/40">
                    <span className="text-white/70">{s.repoName ?? 'Unknown repo'}</span>
                    <span>·</span>
                    <span>{new Date(s.startedAt).toLocaleString()}</span>
                    <span>·</span>
                    <a
                      href={`/me/sessions/${s.sessionId}/transcript`}
                      className="font-mono text-brand-400 hover:underline"
                    >
                      open transcript
                    </a>
                  </div>
                  <div className="space-y-1.5">
                    {s.excerpts.map((e) => (
                      <p
                        key={`${s.sessionId}-${e.role}-${e.ts?.toISOString() ?? ''}`}
                        className="text-sm text-white/70 leading-relaxed"
                        // Excerpt is HTML-escaped server-side (search-queries.highlightExcerpt),
                        // with only <mark> tags re-introduced around matches — safe to render.
                        dangerouslySetInnerHTML={{ __html: e.excerpt }}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function buildUrl(query: string, page: number) {
  const p = new URLSearchParams({ page: String(page), q: query });
  return `/me/search?${p.toString()}`;
}
