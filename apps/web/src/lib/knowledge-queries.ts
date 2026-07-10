import { Prisma } from '@ai-agents-observability/db';

import { getPrisma } from './prisma';

// Aggregate transcript topic clustering (Tier 2 — knowledge-gap detection).
//
// Trust model (OPPORTUNITIES §3.6, §5): the unit of analysis is "how many
// sessions touched topic X", never "who asked about X". Every query here is
// aggregate, visibility-scoped to org-metadata sharers, and only counts
// USER-role messages (the questions developers asked). No transcript content
// leaves the query — only per-topic session/user counts. The page applies
// small-n suppression on top so a topic touched by one or two people can't be
// used to re-identify anyone.
//
// Approach: a fixed keyword taxonomy (not embeddings — the pgvector spike was a
// documented no-go, Phase 7 §12.7). Each topic is a Postgres `to_tsquery` OR of
// stems matched against the generated `content_tsv`. The taxonomy is a code-level
// constant, never user input, so building the aggregate SQL dynamically is safe.

export type KnowledgeTopic = {
  id: string;
  label: string;
  // A Postgres to_tsquery expression (OR of stems). Kept lexeme-simple so the
  // english stemmer matches plurals/tenses (e.g. "migrate" → "migration").
  query: string;
};

export const KNOWLEDGE_TOPICS: KnowledgeTopic[] = [
  {
    id: 'auth',
    label: 'Auth & permissions',
    query: 'auth | authentication | oauth | login | permission | jwt | session',
  },
  {
    id: 'testing',
    label: 'Testing',
    query: 'test | vitest | jest | mock | fixture | assertion | coverage',
  },
  {
    id: 'database',
    label: 'Database & migrations',
    query: 'database | migration | prisma | sql | schema | query | postgres',
  },
  {
    id: 'build',
    label: 'Build & tooling',
    query: 'build | webpack | vite | turbo | bundle | compile | tsconfig',
  },
  {
    id: 'deploy',
    label: 'CI/CD & deploy',
    query: 'deploy | pipeline | docker | kubernetes | release | rollout',
  },
  {
    id: 'perf',
    label: 'Performance',
    query: 'performance | slow | optimize | latency | memory | cache',
  },
  {
    id: 'security',
    label: 'Security',
    query: 'security | vulnerability | secret | encrypt | injection | xss',
  },
  {
    id: 'api',
    label: 'APIs & integration',
    query: 'api | endpoint | rest | graphql | webhook | request',
  },
  {
    id: 'frontend',
    label: 'Frontend & UI',
    query: 'react | component | css | tailwind | render | layout',
  },
  {
    id: 'errors',
    label: 'Errors & debugging',
    query: 'error | exception | crash | debug | traceback | stacktrace',
  },
];

export type KnowledgeTopicRow = {
  id: string;
  label: string;
  sessionCount: number;
  userCount: number;
};

export type KnowledgeResult = {
  topics: KnowledgeTopicRow[];
  totalSessions: number;
};

export async function getKnowledgeTopics(since: Date): Promise<KnowledgeResult> {
  // Two aggregate columns per topic — distinct sessions and distinct users whose
  // user-role messages match the topic query. Aliases are numeric-indexed
  // (`Prisma.raw` on a controlled integer, never user input).
  const cols = KNOWLEDGE_TOPICS.flatMap((t, i) => [
    Prisma.sql`COUNT(DISTINCT ti.session_id) FILTER (
      WHERE ti.content_tsv @@ to_tsquery('english', ${t.query})
    ) AS ${Prisma.raw(`sessions_${i}`)}`,
    Prisma.sql`COUNT(DISTINCT s.user_id) FILTER (
      WHERE ti.content_tsv @@ to_tsquery('english', ${t.query})
    ) AS ${Prisma.raw(`users_${i}`)}`,
  ]);

  const rows = await getPrisma().$queryRaw<Record<string, bigint>[]>(Prisma.sql`
    SELECT
      COUNT(DISTINCT ti.session_id) AS total_sessions,
      ${Prisma.join(cols, ', ')}
    FROM transcript_index ti
    JOIN sessions s ON s.session_id = ti.session_id AND s.started_at >= ${since}
    JOIN users u ON u.id = s.user_id AND u.deactivated_at IS NULL
    LEFT JOIN visibility_policies vp ON vp.user_id = u.id
    WHERE ti.role = 'user'
      AND COALESCE(vp.share_metadata_with_org, true) = true
  `);

  const row = rows[0] ?? {};
  const topics = KNOWLEDGE_TOPICS.map((t, i) => ({
    id: t.id,
    label: t.label,
    sessionCount: Number(row[`sessions_${i}`] ?? 0n),
    userCount: Number(row[`users_${i}`] ?? 0n),
  })).sort((a, b) => b.sessionCount - a.sessionCount);

  return { topics, totalSessions: Number(row.total_sessions ?? 0n) };
}
