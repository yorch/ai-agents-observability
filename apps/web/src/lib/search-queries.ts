import { Prisma } from '@ai-agents-observability/db';
import { getPrisma } from './prisma';

// Shortest query we'll run — guards against pathological full-index scans and
// gives a clean user-facing message instead of a Postgres error.
export const MIN_QUERY_LENGTH = 2;

const HEADLINE_OPTS = 'MaxWords=40, MinWords=15, ShortWord=3';

export type TranscriptMatch = {
  excerpt: string;
  githubLogin: string | null;
  messageIdx: number;
  repoName: string | null;
  role: string;
  sessionId: string;
  startedAt: Date;
  ts: Date | null;
};

/**
 * Shared transcript FTS core. Runs `plainto_tsquery` against the `transcript_index`
 * GIN index and returns `ts_headline` excerpts ranked by relevance.
 *
 * `scope` is a SQL predicate fragment that constrains which sessions are
 * searchable — supplied by each caller so scoping is ALWAYS part of the query,
 * never a post-fetch JS filter (org search = transcript-sharing opt-in; /me search
 * = own `user_id`). `query` must be trimmed and ≥ MIN_QUERY_LENGTH; callers guard.
 */
export async function searchTranscriptMatches(
  query: string,
  scope: Prisma.Sql,
  limit = 20,
): Promise<TranscriptMatch[]> {
  const prisma = getPrisma();
  const rows = await prisma.$queryRaw<
    {
      content_text: string;
      github_login: string | null;
      github_name: string | null;
      github_owner: string | null;
      message_idx: number;
      role: string;
      session_id: string;
      started_at: Date;
      ts: Date | null;
    }[]
  >(Prisma.sql`
    SELECT
      ti.session_id::text          AS session_id,
      ti.message_idx,
      ti.role,
      ti.ts,
      s.started_at,
      u.github_login,
      r.github_owner,
      r.github_name,
      ts_headline('english', ti.content_text,
        plainto_tsquery('english', ${query}), ${HEADLINE_OPTS}
      )                            AS content_text
    FROM transcript_index ti
    JOIN sessions s ON s.session_id = ti.session_id
    JOIN users u ON u.id = s.user_id
    LEFT JOIN repos r ON r.id = s.repo_id
    LEFT JOIN visibility_policies vp ON vp.user_id = u.id
    WHERE ti.content_tsv @@ plainto_tsquery('english', ${query})
      AND u.deactivated_at IS NULL
      ${scope}
    ORDER BY ts_rank(ti.content_tsv, plainto_tsquery('english', ${query})) DESC
    LIMIT ${limit}
  `);

  return rows.map((r) => ({
    excerpt: r.content_text,
    githubLogin: r.github_login,
    messageIdx: r.message_idx,
    repoName: r.github_owner && r.github_name ? `${r.github_owner}/${r.github_name}` : null,
    role: r.role,
    sessionId: r.session_id,
    startedAt: r.started_at,
    ts: r.ts,
  }));
}

const OWN_PAGE_SIZE = 20;
const MAX_EXCERPTS_PER_SESSION = 3;
// Upper bound on matched messages fetched in one pass. Generous for a single
// user's own transcripts; if a query ever saturates this, `total` is a floor and
// later pages may under-count — acceptable for personal search.
const OWN_FETCH_LIMIT = 300;

export type TranscriptSessionMatch = {
  excerpts: { excerpt: string; role: string; ts: Date | null }[];
  repoName: string | null;
  sessionId: string;
  startedAt: Date;
};

export type OwnTranscriptSearch = {
  page: number;
  pageSize: number;
  sessions: TranscriptSessionMatch[];
  total: number;
};

/**
 * Per-user transcript search, scoped in SQL to the caller's own sessions
 * (`s.user_id = $userId` — cross-user leakage is structurally impossible). Groups
 * matches by session, keeps the top ≤3 excerpts per session (matches arrive
 * rank-ordered), and paginates the resulting sessions 20 per page.
 */
export async function searchOwnTranscripts(
  userId: string,
  query: string,
  page = 1,
): Promise<OwnTranscriptSearch> {
  const q = query.trim();
  if (q.length < MIN_QUERY_LENGTH) {
    return { page: Math.max(1, page), pageSize: OWN_PAGE_SIZE, sessions: [], total: 0 };
  }

  const matches = await searchTranscriptMatches(
    q,
    Prisma.sql`AND s.user_id = ${userId}::uuid`,
    OWN_FETCH_LIMIT,
  );

  // Group preserving rank order (matches are ordered by ts_rank DESC, so the
  // first session seen is the best-ranked).
  const bySession = new Map<string, TranscriptSessionMatch>();
  for (const m of matches) {
    let entry = bySession.get(m.sessionId);
    if (!entry) {
      entry = {
        excerpts: [],
        repoName: m.repoName,
        sessionId: m.sessionId,
        startedAt: m.startedAt,
      };
      bySession.set(m.sessionId, entry);
    }
    if (entry.excerpts.length < MAX_EXCERPTS_PER_SESSION) {
      entry.excerpts.push({ excerpt: m.excerpt, role: m.role, ts: m.ts });
    }
  }

  const all = [...bySession.values()];
  const safePage = Math.max(1, page);
  const start = (safePage - 1) * OWN_PAGE_SIZE;
  return {
    page: safePage,
    pageSize: OWN_PAGE_SIZE,
    sessions: all.slice(start, start + OWN_PAGE_SIZE),
    total: all.length,
  };
}
