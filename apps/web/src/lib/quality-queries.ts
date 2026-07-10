import { Prisma } from '@ai-agents-observability/db';

import { getPrisma } from './prisma';

// Quality-correlation queries (org scope, §3.5 of OPPORTUNITIES): join agent
// session characteristics to PR outcome signals. Everything here is
// deliberately framed as association, not causation — the page's job is to
// surface where the outcome rates diverge, with sample sizes shown, so humans
// decide what to investigate.

// Bug/Defect issue-type names (lowercased) that mark a ticket as defect work.
const BUG_TYPES_SQL = Prisma.sql`('bug', 'defect')`;

// Tickets that have a Jira-linked Bug/Defect on either side of the link.
// "Linked" is the honest unit: link semantics ("is caused by" vs "relates to")
// are surfaced verbatim in the attribution table, not interpreted.
function bugLinkedTicketsSql(): Prisma.Sql {
  return Prisma.sql`
    SELECT DISTINCT l.target_key AS ticket_key
    FROM jira_issue_links l
    JOIN jira_issues b ON b.key = l.source_key
    WHERE lower(b.issue_type) IN ${BUG_TYPES_SQL}
    UNION
    SELECT DISTINCT l.source_key AS ticket_key
    FROM jira_issue_links l
    JOIN jira_issues b ON b.key = l.target_key
    WHERE lower(b.issue_type) IN ${BUG_TYPES_SQL}
  `;
}

export type FrictionBandOutcomeRow = {
  avgCostUsd: number;
  band: 'low' | 'medium' | 'high';
  bugLinked: number;
  ciFailed: number;
  mergedPrs: number;
  reverted: number;
};

// Outcome rates for merged PRs bucketed by the mean friction score of their
// contributing sessions (same 0.3/0.6 thresholds as the session friction
// bands). Revert and CI-failure come from internal data; bug-linked requires
// the Jira sync. PRs with no scored contributing session are excluded — an
// unknown-friction bucket would say nothing about the correlation.
export async function getOutcomesByFrictionBand(since: Date): Promise<FrictionBandOutcomeRow[]> {
  const rows = await getPrisma().$queryRaw<
    {
      avg_cost: number | null;
      band: string;
      bug_linked: bigint;
      ci_failed: bigint;
      merged_prs: bigint;
      reverted: bigint;
    }[]
  >(Prisma.sql`
    WITH pr_friction AS (
      SELECT l.repo_id, l.pr_number, AVG(s.friction_score) AS mean_friction
      FROM session_pr_links l
      JOIN sessions s ON s.session_id = l.session_id
      WHERE s.friction_score IS NOT NULL
      GROUP BY l.repo_id, l.pr_number
    ),
    bug_linked_tickets AS (${bugLinkedTicketsSql()})
    SELECT
      CASE
        WHEN pf.mean_friction < 0.3 THEN 'low'
        WHEN pf.mean_friction <= 0.6 THEN 'medium'
        ELSE 'high'
      END                                                            AS band,
      COUNT(*)                                                       AS merged_prs,
      COUNT(*) FILTER (WHERE pr.reverted_at IS NOT NULL)             AS reverted,
      COUNT(*) FILTER (WHERE COALESCE(prr.check_failures_count, 0) > 0) AS ci_failed,
      COUNT(*) FILTER (WHERE blt.ticket_key IS NOT NULL)             AS bug_linked,
      AVG(prr.total_cost_usd)                                        AS avg_cost
    FROM pull_requests pr
    JOIN pr_friction pf ON pf.repo_id = pr.repo_id AND pf.pr_number = pr.pr_number
    LEFT JOIN pr_rollups prr ON prr.repo_id = pr.repo_id AND prr.pr_number = pr.pr_number
    LEFT JOIN bug_linked_tickets blt ON blt.ticket_key = pr.jira_key
    WHERE pr.state = 'MERGED' AND pr.merged_at >= ${since}
    GROUP BY 1
  `);

  const order: Record<string, number> = { high: 2, low: 0, medium: 1 };
  return rows
    .map((r) => ({
      avgCostUsd: Number(r.avg_cost ?? 0),
      band: r.band as FrictionBandOutcomeRow['band'],
      bugLinked: Number(r.bug_linked),
      ciFailed: Number(r.ci_failed),
      mergedPrs: Number(r.merged_prs),
      reverted: Number(r.reverted),
    }))
    .sort((a, b) => (order[a.band] ?? 0) - (order[b.band] ?? 0));
}

export type DefectAttributionRow = {
  bugCreatedAt: Date | null;
  bugKey: string;
  bugStatus: string | null;
  bugSummary: string | null;
  linkPhrase: string | null;
  originKey: string;
  originMergedPrs: number;
  originSpendUsd: number;
};

// Bugs attributed to tracked work through explicit Jira issue links: the bug
// links (either direction) to a ticket that has PRs in our system. The link
// phrase is shown verbatim ("is caused by" carries more weight than
// "relates to") — attribution reports linkage; humans judge causation.
export async function getDefectAttributions(
  since: Date,
  limit = 20,
): Promise<DefectAttributionRow[]> {
  const rows = await getPrisma().$queryRaw<
    {
      bug_created_at: Date | null;
      bug_key: string;
      bug_status: string | null;
      bug_summary: string | null;
      link_phrase: string | null;
      origin_key: string;
      origin_merged: bigint;
      origin_spend: number | null;
    }[]
  >(Prisma.sql`
    WITH bug_origin AS (
      SELECT
        b.key              AS bug_key,
        b.summary          AS bug_summary,
        b.status           AS bug_status,
        b.issue_created_at AS bug_created_at,
        l.description      AS link_phrase,
        CASE WHEN l.source_key = b.key THEN l.target_key ELSE l.source_key END AS origin_key
      FROM jira_issue_links l
      JOIN jira_issues b ON b.key = l.source_key OR b.key = l.target_key
      WHERE lower(b.issue_type) IN ${BUG_TYPES_SQL}
    )
    SELECT
      bo.bug_key                                              AS bug_key,
      bo.bug_summary                                          AS bug_summary,
      bo.bug_status                                           AS bug_status,
      bo.bug_created_at                                       AS bug_created_at,
      bo.link_phrase                                          AS link_phrase,
      bo.origin_key                                           AS origin_key,
      COUNT(pr.github_id) FILTER (WHERE pr.state = 'MERGED')  AS origin_merged,
      COALESCE(SUM(prr.total_cost_usd), 0)                    AS origin_spend
    FROM bug_origin bo
    JOIN pull_requests pr ON pr.jira_key = bo.origin_key
    LEFT JOIN pr_rollups prr ON prr.repo_id = pr.repo_id AND prr.pr_number = pr.pr_number
    WHERE bo.bug_created_at IS NULL OR bo.bug_created_at >= ${since}
    GROUP BY bo.bug_key, bo.bug_summary, bo.bug_status, bo.bug_created_at,
             bo.link_phrase, bo.origin_key
    ORDER BY bo.bug_created_at DESC NULLS LAST
    LIMIT ${limit}
  `);

  return rows.map((r) => ({
    bugCreatedAt: r.bug_created_at,
    bugKey: r.bug_key,
    bugStatus: r.bug_status,
    bugSummary: r.bug_summary,
    linkPhrase: r.link_phrase,
    originKey: r.origin_key,
    originMergedPrs: Number(r.origin_merged),
    originSpendUsd: Number(r.origin_spend ?? 0),
  }));
}
