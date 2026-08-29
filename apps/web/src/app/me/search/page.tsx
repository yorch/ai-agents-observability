import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowLeftIcon, ArrowRightIcon } from '@/components/icons';
import { Button, Card, Input } from '@/components/ui';
import { format } from '@/i18n/config';
import { getTranslations } from '@/i18n/server';
import { currentUser } from '@/lib/auth';
import { fmtDateTime } from '@/lib/fmt';
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

  const { dict } = await getTranslations();
  const params = await searchParams;
  const rawQuery = params.q ?? '';
  const query = rawQuery.trim();
  const page = Math.max(1, Number(params.page ?? '1') || 1);

  const tooShort = query.length > 0 && query.length < MIN_QUERY_LENGTH;
  const results =
    query.length >= MIN_QUERY_LENGTH ? await searchOwnTranscripts(user.id, query, page) : null;
  const totalPages = results ? Math.ceil(results.total / results.pageSize) : 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-semibold tracking-tight text-text">
          Search my transcripts
        </h1>
        <p className="mt-1 text-sm text-text-2">
          Full-text search across your own session transcripts.
        </p>
      </div>

      <form method="GET" className="flex flex-wrap gap-3">
        <Input
          type="text"
          name="q"
          defaultValue={rawQuery}
          placeholder={dict.me.search.placeholder}
          aria-label={dict.me.search.ariaLabel}
          className="flex-1"
        />
        <Button type="submit">{dict.me.search.submit}</Button>
      </form>

      {!query && <p className="text-sm text-text-3">{dict.me.search.hint}</p>}

      {tooShort && (
        <p className="text-sm text-warn">
          {format(dict.me.search.minChars, { n: MIN_QUERY_LENGTH })}
        </p>
      )}

      {results && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <h2 className="font-display text-sm font-semibold text-text">
              {format(dict.me.search.matches, { count: results.total })}
            </h2>
            {totalPages > 1 && (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                {page > 1 && (
                  <Link
                    href={buildUrl(query, page - 1)}
                    className="inline-flex items-center gap-1 text-accent hover:underline"
                  >
                    <ArrowLeftIcon /> {dict.common.prev}
                  </Link>
                )}
                <span className="text-text-3">
                  {page} {dict.common.of} {totalPages}
                </span>
                {page < totalPages && (
                  <Link
                    href={buildUrl(query, page + 1)}
                    className="inline-flex items-center gap-1 text-accent hover:underline"
                  >
                    {dict.common.next} <ArrowRightIcon />
                  </Link>
                )}
              </div>
            )}
          </div>

          {results.sessions.length === 0 ? (
            <p className="text-sm text-text-3">{dict.me.search.empty}</p>
          ) : (
            <div className="space-y-3">
              {results.sessions.map((s) => (
                <Card key={s.sessionId} contentClassName="space-y-2">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-text-3">
                    <span className="text-text-2">{s.repoName ?? dict.me.search.unknownRepo}</span>
                    <span>·</span>
                    <span>{fmtDateTime(new Date(s.startedAt))} UTC</span>
                    <span>·</span>
                    <Link
                      href={`/me/sessions/${s.sessionId}/transcript`}
                      className="font-mono text-accent hover:underline"
                    >
                      {dict.me.search.openTranscript}
                    </Link>
                  </div>
                  <div className="space-y-1.5">
                    {s.excerpts.map((e) => (
                      <p
                        key={`${s.sessionId}-${e.role}-${e.ts?.toISOString() ?? ''}`}
                        className="text-sm text-text-2 leading-relaxed"
                        // Excerpt is HTML-escaped server-side (search-queries.highlightExcerpt),
                        // with only <mark> tags re-introduced around matches — safe to render.
                        dangerouslySetInnerHTML={{ __html: e.excerpt }}
                      />
                    ))}
                  </div>
                </Card>
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
