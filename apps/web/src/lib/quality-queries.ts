import { Prisma } from '@ai-agents-observability/db';
import {
  BUG_ISSUE_TYPE_LIST,
  FRICTION_BAND_HIGH,
  FRICTION_BAND_LOW,
} from '@ai-agents-observability/schemas';

import { getPrisma } from './prisma';

// Quality-correlation queries (org scope, §3.5 of OPPORTUNITIES): join agent
// session characteristics to PR outcome signals. Everything here is
// deliberately framed as association, not causation — the page's job is to
// surface where the outcome rates diverge, with sample sizes shown, so humans
// decide what to investigate.

// Defect issue-type names, from the shared domain constant so the ROI page's
// TS Set and this SQL IN-list can never disagree on what counts as a bug.
const BUG_TYPES_SQL = Prisma.sql`(${Prisma.join([...BUG_ISSUE_TYPE_LIST])})`;

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
// contributing sessions (shared FRICTION_BAND_LOW/HIGH thresholds). Revert and
// CI-failure come from internal data; bug-linked requires the Jira sync. PRs
// with no scored contributing session are excluded — an unknown-friction
// bucket would say nothing about the correlation.
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
      -- Window applied inside the CTE so only in-window merged PRs' links are
      -- aggregated, not the whole session_pr_links history.
      SELECT l.repo_id, l.pr_number, AVG(s.friction_score) AS mean_friction
      FROM pull_requests pr
      JOIN session_pr_links l ON l.repo_id = pr.repo_id AND l.pr_number = pr.pr_number
      JOIN sessions s ON s.session_id = l.session_id
      WHERE pr.state = 'MERGED' AND pr.merged_at >= ${since}
        AND s.friction_score IS NOT NULL
      GROUP BY l.repo_id, l.pr_number
    ),
    bug_linked_tickets AS (${bugLinkedTicketsSql()})
    SELECT
      CASE
        WHEN pf.mean_friction < ${FRICTION_BAND_LOW} THEN 'low'
        WHEN pf.mean_friction <= ${FRICTION_BAND_HIGH} THEN 'medium'
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

  const bandOrder: FrictionBandOutcomeRow['band'][] = ['low', 'medium', 'high'];
  return rows
    .map((r) => ({
      avgCostUsd: Number(r.avg_cost ?? 0),
      band: r.band as FrictionBandOutcomeRow['band'],
      bugLinked: Number(r.bug_linked),
      ciFailed: Number(r.ci_failed),
      mergedPrs: Number(r.merged_prs),
      reverted: Number(r.reverted),
    }))
    .sort((a, b) => bandOrder.indexOf(a.band) - bandOrder.indexOf(b.band));
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
// Origins that are themselves bugs are excluded so a bug↔bug link doesn't
// render as two mirrored rows. Bugs without a synced created date are
// excluded: the sync always fetches `created`, so NULL means a stale legacy
// row, and letting it bypass the window would pin it into every range.
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
      -- Two index-friendly halves (bug on either link endpoint) instead of an
      -- OR-join; the window predicate prunes inside the CTE.
      SELECT b.key AS bug_key, b.summary AS bug_summary, b.status AS bug_status,
             b.issue_created_at AS bug_created_at, l.description AS link_phrase,
             l.target_key AS origin_key
      FROM jira_issue_links l
      JOIN jira_issues b ON b.key = l.source_key
      WHERE lower(b.issue_type) IN ${BUG_TYPES_SQL}
        AND b.issue_created_at >= ${since}
      UNION
      SELECT b.key, b.summary, b.status, b.issue_created_at, l.description,
             l.source_key
      FROM jira_issue_links l
      JOIN jira_issues b ON b.key = l.target_key
      WHERE lower(b.issue_type) IN ${BUG_TYPES_SQL}
        AND b.issue_created_at >= ${since}
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
    LEFT JOIN jira_issues origin ON origin.key = bo.origin_key
    WHERE origin.issue_type IS NULL OR lower(origin.issue_type) NOT IN ${BUG_TYPES_SQL}
    GROUP BY bo.bug_key, bo.bug_summary, bo.bug_status, bo.bug_created_at,
             bo.link_phrase, bo.origin_key
    ORDER BY bo.bug_created_at DESC
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
