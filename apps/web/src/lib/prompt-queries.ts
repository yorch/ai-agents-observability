import { Prisma } from '@ai-agents-observability/db';

import { getPrisma } from './prisma';

// E3: Prompt pattern mining — clusters user prompts by intent and shows
// success/cost per cluster.
//
// Trust model (same as knowledge-queries.ts): the unit of analysis is "how
// many sessions/users had prompts matching intent X", never "who asked X".
// Every query is aggregate, visibility-scoped to org-metadata sharers, and
// only counts USER-role messages. No transcript content leaves the query —
// only per-intent aggregate counts, cost, and friction. The page applies
// small-n suppression on top.
//
// Approach: a fixed intent taxonomy (not embeddings — the pgvector spike was
// a documented no-go). Each intent is a Postgres `to_tsquery` OR of stems
// matched against the generated `content_tsv`. The taxonomy is a code-level
// constant, never user input, so building the aggregate SQL dynamically is
// safe.

export type PromptIntent = {
  id: string;
  label: string;
  // A Postgres to_tsquery expression (OR of stems).
  query: string;
};

// Intent clusters — what the developer is trying to DO, not what topic they
// are asking about (that's knowledge-queries.ts). The stems are chosen to
// match imperative and interrogative forms: "implement X", "debug this",
// "why is X slow", "write a test for", etc.
export const PROMPT_INTENTS: PromptIntent[] = [
  {
    id: 'implement',
    label: 'Implement feature',
    query: 'implement | build | create | add | write | develop | generate | scaffold',
  },
  {
    id: 'debug',
    label: 'Debug & fix',
    query: 'debug | fix | bug | error | broken | crash | fail | wrong | issue | investigate',
  },
  {
    id: 'refactor',
    label: 'Refactor',
    query: 'refactor | restructure | rename | extract | cleanup | clean | simplify | reorganize',
  },
  {
    id: 'test',
    label: 'Testing',
    query: 'test | vitest | jest | mock | fixture | assertion | coverage | spec',
  },
  {
    id: 'review',
    label: 'Review & check',
    query: 'review | check | verify | inspect | audit | lint | analyze | validate',
  },
  {
    id: 'explain',
    label: 'Explain & explore',
    query: 'explain | understand | how | why | what | where | explore | find | search | show',
  },
  {
    id: 'config',
    label: 'Config & setup',
    query: 'config | configure | setup | install | environment | deploy | env | setting',
  },
  {
    id: 'docs',
    label: 'Documentation',
    query: 'document | docs | readme | comment | describe | documentation',
  },
  {
    id: 'optimize',
    label: 'Optimize',
    query: 'optimize | performance | slow | speed | latency | memory | efficient | cache',
  },
  {
    id: 'security',
    label: 'Security',
    query: 'security | vulnerability | secret | encrypt | injection | xss | auth | permission',
  },
];

export type PromptIntentRow = {
  avgCostUsd: number;
  avgFriction: number | null;
  id: string;
  label: string;
  promptCount: number;
  sessionCount: number;
  totalCostUsd: number;
  userCount: number;
};

export type PromptMiningResult = {
  intents: PromptIntentRow[];
  totalSessions: number;
};

export async function getPromptIntents(since: Date): Promise<PromptMiningResult> {
  // Drive from interactive_sessions (one row per session) and use EXISTS
  // subqueries for intent matching. This ensures SUM(s.total_cost_usd) and
  // AVG(s.friction_score) are per-session, not multiplied by the number of
  // matching transcript_index rows. Prompt counts use a correlated subquery.
  //
  // Aliases are numeric-indexed (`Prisma.raw` on a controlled integer, never
  // user input). The taxonomy is a code-level constant, never user input, so
  // interpolating it into to_tsquery is safe.
  const cols = PROMPT_INTENTS.flatMap((t, i) => [
    Prisma.sql`COUNT(*) FILTER (
      WHERE EXISTS (
        SELECT 1 FROM transcript_index ti
        WHERE ti.session_id = s.session_id
          AND ti.role = 'user'
          AND ti.content_tsv @@ to_tsquery('english', ${t.query})
      )
    ) AS ${Prisma.raw(`sessions_${i}`)}`,
    Prisma.sql`COUNT(DISTINCT s.user_id) FILTER (
      WHERE EXISTS (
        SELECT 1 FROM transcript_index ti
        WHERE ti.session_id = s.session_id
          AND ti.role = 'user'
          AND ti.content_tsv @@ to_tsquery('english', ${t.query})
      )
    ) AS ${Prisma.raw(`users_${i}`)}`,
    Prisma.sql`COALESCE(SUM(
      (SELECT COUNT(*) FROM transcript_index ti
       WHERE ti.session_id = s.session_id
         AND ti.role = 'user'
         AND ti.content_tsv @@ to_tsquery('english', ${t.query}))
    ) FILTER (
      WHERE EXISTS (
        SELECT 1 FROM transcript_index ti
        WHERE ti.session_id = s.session_id
          AND ti.role = 'user'
          AND ti.content_tsv @@ to_tsquery('english', ${t.query})
      )
    ), 0) AS ${Prisma.raw(`prompts_${i}`)}`,
    Prisma.sql`COALESCE(SUM(s.total_cost_usd) FILTER (
      WHERE EXISTS (
        SELECT 1 FROM transcript_index ti
        WHERE ti.session_id = s.session_id
          AND ti.role = 'user'
          AND ti.content_tsv @@ to_tsquery('english', ${t.query})
      )
    ), 0) AS ${Prisma.raw(`cost_${i}`)}`,
    Prisma.sql`AVG(s.friction_score) FILTER (
      WHERE EXISTS (
        SELECT 1 FROM transcript_index ti
        WHERE ti.session_id = s.session_id
          AND ti.role = 'user'
          AND ti.content_tsv @@ to_tsquery('english', ${t.query})
      )
    ) AS ${Prisma.raw(`friction_${i}`)}`,
  ]);

  const rows = await getPrisma().$queryRaw<Record<string, string | number | null | bigint>[]>(
    Prisma.sql`
      SELECT
        COUNT(*) AS total_sessions,
        ${Prisma.join(cols, ', ')}
      FROM interactive_sessions s
      JOIN users u ON u.id = s.user_id AND u.deactivated_at IS NULL
      LEFT JOIN visibility_policies vp ON vp.user_id = u.id
      WHERE s.started_at >= ${since}
        AND COALESCE(vp.share_metadata_with_org, true) = true
        AND EXISTS (
          SELECT 1 FROM transcript_index ti
          WHERE ti.session_id = s.session_id AND ti.role = 'user'
        )
    `,
  );

  const row = rows[0] ?? {};
  const intents = PROMPT_INTENTS.map((t, i) => {
    const sessionCount = Number(row[`sessions_${i}`] ?? 0n);
    const totalCostUsd = Number(row[`cost_${i}`] ?? 0);
    const frictionRaw = row[`friction_${i}`];
    return {
      avgCostUsd: sessionCount > 0 ? totalCostUsd / sessionCount : 0,
      avgFriction: frictionRaw !== null && frictionRaw !== undefined ? Number(frictionRaw) : null,
      id: t.id,
      label: t.label,
      promptCount: Number(row[`prompts_${i}`] ?? 0n),
      sessionCount,
      totalCostUsd,
      userCount: Number(row[`users_${i}`] ?? 0n),
    };
  }).sort((a, b) => b.sessionCount - a.sessionCount);

  return { intents, totalSessions: Number(row.total_sessions ?? 0n) };
}
