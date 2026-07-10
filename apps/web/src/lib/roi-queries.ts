import { Prisma } from '@ai-agents-observability/db';

import { getPrisma } from './prisma';

// Outcome-based ROI queries (org scope). These complement org-queries' delivery
// stats (throughput, cycle time, cost-per-PR) by joining agent SPEND to delivery
// OUTCOMES: spend tied up in reverted work, the cost gap between clean-CI and
// CI-failed merges, cost allocation by Jira initiative, and per-repo ROI quality.
//
// All grains are PR-level (one row per pull request, cost from its pr_rollup), so
// no double-counting. Like the delivery queries, these are NOT visibility-policy
// filtered: a PR is an org artifact, and its rollup cost is already an aggregate.

export type OrgRoiSummary = {
  ciCleanMergeRate: number; // merged PRs with no CI failures / merged PRs
  costPerMergedPr: number;
  mergedPrs: number;
  revertedPrs: number;
  revertedSpendShare: number; // reverted spend / total spend
  revertedSpendUsd: number;
  totalSpendUsd: number;
};

export async function getOrgRoiSummary(since: Date): Promise<OrgRoiSummary> {
  const rows = await getPrisma().$queryRaw<
    {
      ci_failed_merged_prs: bigint;
      clean_merged_prs: bigint;
      merged_prs: bigint;
      merged_spend: number | null;
      reverted_prs: bigint;
      reverted_spend: number | null;
      total_spend: number | null;
    }[]
  >(Prisma.sql`
    SELECT
      COALESCE(SUM(prr.total_cost_usd), 0)                                          AS total_spend,
      COUNT(pr.github_id) FILTER (WHERE pr.state = 'MERGED')                        AS merged_prs,
      COALESCE(SUM(prr.total_cost_usd) FILTER (WHERE pr.state = 'MERGED'), 0)       AS merged_spend,
      COUNT(pr.github_id) FILTER (WHERE pr.reverted_at IS NOT NULL)                 AS reverted_prs,
      COALESCE(SUM(prr.total_cost_usd) FILTER (WHERE pr.reverted_at IS NOT NULL), 0) AS reverted_spend,
      COUNT(pr.github_id) FILTER (
        WHERE pr.state = 'MERGED' AND COALESCE(prr.check_failures_count, 0) = 0
      )                                                                             AS clean_merged_prs,
      COUNT(pr.github_id) FILTER (
        WHERE pr.state = 'MERGED' AND COALESCE(prr.check_failures_count, 0) > 0
      )                                                                             AS ci_failed_merged_prs
    FROM pull_requests pr
    LEFT JOIN pr_rollups prr
      ON prr.repo_id = pr.repo_id AND prr.pr_number = pr.pr_number
    WHERE pr.opened_at >= ${since}
  `);

  const r = rows[0];
  const totalSpend = Number(r?.total_spend ?? 0);
  const mergedSpend = Number(r?.merged_spend ?? 0);
  const merged = Number(r?.merged_prs ?? 0);
  const cleanMerged = Number(r?.clean_merged_prs ?? 0);
  const revertedSpend = Number(r?.reverted_spend ?? 0);

  return {
    ciCleanMergeRate: merged > 0 ? cleanMerged / merged : 0,
    costPerMergedPr: merged > 0 ? mergedSpend / merged : 0,
    mergedPrs: merged,
    revertedPrs: Number(r?.reverted_prs ?? 0),
    revertedSpendShare: totalSpend > 0 ? revertedSpend / totalSpend : 0,
    revertedSpendUsd: revertedSpend,
    totalSpendUsd: totalSpend,
  };
}

export type CiCostCorrelation = {
  cleanAvgCost: number;
  cleanCount: number;
  failedAvgCost: number;
  failedCount: number;
};

// Compares the average agent cost of merged PRs that passed CI cleanly vs those
// that needed one or more failing check runs along the way. A large gap is a
// concrete "rework costs money" signal.
//
// Scoped on opened_at (matching getOrgRoiSummary, so both describe the same trailing
// window of PRs) and counted with COUNT(total_cost_usd) — not COUNT(*) — so the "N
// PRs" label and the AVG cover the same costed population (PRs whose rollup has a
// non-null cost). PRs without a cost rollup contribute to neither.
export async function getCiCostCorrelation(since: Date): Promise<CiCostCorrelation> {
  const rows = await getPrisma().$queryRaw<
    {
      clean_avg_cost: number | null;
      clean_count: bigint;
      failed_avg_cost: number | null;
      failed_count: bigint;
    }[]
  >(Prisma.sql`
    SELECT
      COUNT(prr.total_cost_usd) FILTER (WHERE COALESCE(prr.check_failures_count, 0) = 0)
                                                                          AS clean_count,
      AVG(prr.total_cost_usd) FILTER (WHERE COALESCE(prr.check_failures_count, 0) = 0)
                                                                          AS clean_avg_cost,
      COUNT(prr.total_cost_usd) FILTER (WHERE COALESCE(prr.check_failures_count, 0) > 0)
                                                                          AS failed_count,
      AVG(prr.total_cost_usd) FILTER (WHERE COALESCE(prr.check_failures_count, 0) > 0)
                                                                          AS failed_avg_cost
    FROM pull_requests pr
    LEFT JOIN pr_rollups prr
      ON prr.repo_id = pr.repo_id AND prr.pr_number = pr.pr_number
    WHERE pr.state = 'MERGED' AND pr.opened_at >= ${since}
  `);

  const r = rows[0];
  return {
    cleanAvgCost: Number(r?.clean_avg_cost ?? 0),
    cleanCount: Number(r?.clean_count ?? 0),
    failedAvgCost: Number(r?.failed_avg_cost ?? 0),
    failedCount: Number(r?.failed_count ?? 0),
  };
}

// Per-ticket session spend for the window — a single definition shared by the
// ticket and epic rollups so the two dashboards can't disagree on what
// "session spend" means.
function sessionSpendByKeySql(since: Date): Prisma.Sql {
  return Prisma.sql`
    SELECT
      s.jira_key                          AS jira_key,
      COUNT(*)                            AS session_count,
      COALESCE(SUM(s.total_cost_usd), 0)  AS session_cost
    FROM sessions s
    WHERE s.started_at >= ${since} AND s.jira_key IS NOT NULL
    GROUP BY s.jira_key
  `;
}

export type JiraSpendRow = {
  issueType: string | null;
  jiraKey: string;
  mergedPrs: number;
  prCount: number;
  sessionCostUsd: number;
  sessionCount: number;
  status: string | null;
  summary: string | null;
  totalCostUsd: number;
};

// Cost allocation by Jira ticket. Two spend grains per key: PR-rollup spend
// (P5-004, key from the PR branch/title) and direct session spend (key from the
// session's git branch) — the session grain also counts work that never reached
// a PR. Issue metadata comes from jira_issues when the sync-jira job has run.
export async function getSpendByJiraKey(since: Date, limit = 15): Promise<JiraSpendRow[]> {
  const rows = await getPrisma().$queryRaw<
    {
      issue_type: string | null;
      jira_key: string;
      merged_prs: bigint | null;
      pr_count: bigint | null;
      pr_cost: number | null;
      session_cost: number | null;
      session_count: bigint | null;
      status: string | null;
      summary: string | null;
    }[]
  >(Prisma.sql`
    WITH pr_spend AS (
      SELECT
        pr.jira_key                                              AS jira_key,
        COUNT(pr.github_id)                                      AS pr_count,
        COUNT(pr.github_id) FILTER (WHERE pr.state = 'MERGED')   AS merged_prs,
        COALESCE(SUM(prr.total_cost_usd), 0)                     AS pr_cost
      FROM pull_requests pr
      LEFT JOIN pr_rollups prr
        ON prr.repo_id = pr.repo_id AND prr.pr_number = pr.pr_number
      WHERE pr.opened_at >= ${since} AND pr.jira_key IS NOT NULL
      GROUP BY pr.jira_key
    ),
    session_spend AS (${sessionSpendByKeySql(since)})
    SELECT
      COALESCE(p.jira_key, ss.jira_key) AS jira_key,
      ji.summary                        AS summary,
      ji.status                         AS status,
      ji.issue_type                     AS issue_type,
      p.pr_count                        AS pr_count,
      p.merged_prs                      AS merged_prs,
      p.pr_cost                         AS pr_cost,
      ss.session_count                  AS session_count,
      ss.session_cost                   AS session_cost
    FROM pr_spend p
    FULL OUTER JOIN session_spend ss ON ss.jira_key = p.jira_key
    LEFT JOIN jira_issues ji ON ji.key = COALESCE(p.jira_key, ss.jira_key)
    ORDER BY GREATEST(COALESCE(p.pr_cost, 0), COALESCE(ss.session_cost, 0)) DESC
    LIMIT ${limit}
  `);

  return rows.map((r) => ({
    issueType: r.issue_type,
    jiraKey: r.jira_key,
    mergedPrs: Number(r.merged_prs ?? 0),
    prCount: Number(r.pr_count ?? 0),
    sessionCostUsd: Number(r.session_cost ?? 0),
    sessionCount: Number(r.session_count ?? 0),
    status: r.status,
    summary: r.summary,
    totalCostUsd: Number(r.pr_cost ?? 0),
  }));
}

export type EpicSpendRow = {
  epicKey: string;
  epicSummary: string | null;
  mergedPrs: number;
  sessionCostUsd: number;
  ticketCount: number;
};

// Feature-level cost attribution: ticket spend rolled up to the Jira epic. Only
// possible once sync-jira has resolved issues (epic_key comes from jira_issues),
// so an empty result with configured Jira usually means the job hasn't run yet.
// Tickets join via LEFT JOINs on BOTH grains — a ticket whose sessions predate
// the window but whose merged PRs are inside it still counts toward the epic.
export async function getSpendByEpic(since: Date, limit = 10): Promise<EpicSpendRow[]> {
  const rows = await getPrisma().$queryRaw<
    {
      epic_key: string;
      epic_summary: string | null;
      merged_prs: bigint | null;
      session_cost: number | null;
      ticket_count: bigint;
    }[]
  >(Prisma.sql`
    WITH ticket AS (${sessionSpendByKeySql(since)}),
    merged AS (
      SELECT pr.jira_key AS jira_key, COUNT(*) AS merged_prs
      FROM pull_requests pr
      WHERE pr.opened_at >= ${since} AND pr.jira_key IS NOT NULL AND pr.state = 'MERGED'
      GROUP BY pr.jira_key
    )
    SELECT
      ji.epic_key                          AS epic_key,
      epic.summary                         AS epic_summary,
      COUNT(DISTINCT ji.key)               AS ticket_count,
      COALESCE(SUM(t.session_cost), 0)     AS session_cost,
      COALESCE(SUM(m.merged_prs), 0)       AS merged_prs
    FROM jira_issues ji
    LEFT JOIN ticket t ON t.jira_key = ji.key
    LEFT JOIN merged m ON m.jira_key = ji.key
    LEFT JOIN jira_issues epic ON epic.key = ji.epic_key
    WHERE ji.epic_key IS NOT NULL
      AND (t.jira_key IS NOT NULL OR m.jira_key IS NOT NULL)
    GROUP BY ji.epic_key, epic.summary
    ORDER BY session_cost DESC
    LIMIT ${limit}
  `);

  return rows.map((r) => ({
    epicKey: r.epic_key,
    epicSummary: r.epic_summary,
    mergedPrs: Number(r.merged_prs ?? 0),
    sessionCostUsd: Number(r.session_cost ?? 0),
    ticketCount: Number(r.ticket_count),
  }));
}

export type CommitProvenance = {
  linkedCommits: number;
  sessionsWithCommits: number;
};

// "Merged commits touched by an agent session" — the §10.5-sanctioned substitute
// for LOC-style vanity metrics: it requires the code to have survived review and
// landed on the default branch. Populated by the push webhook (§7.2).
export async function getCommitProvenance(since: Date): Promise<CommitProvenance> {
  const rows = await getPrisma().$queryRaw<
    { linked_commits: bigint; sessions_with_commits: bigint }[]
  >(Prisma.sql`
    SELECT
      COUNT(DISTINCT (repo_id, commit_sha)) AS linked_commits,
      COUNT(DISTINCT session_id)            AS sessions_with_commits
    FROM session_commit_links
    WHERE committed_at >= ${since}
  `);

  return {
    linkedCommits: Number(rows[0]?.linked_commits ?? 0),
    sessionsWithCommits: Number(rows[0]?.sessions_with_commits ?? 0),
  };
}

export type RepoRoiRow = {
  ciCleanRate: number;
  costPerMergedPr: number;
  mergedPrs: number;
  mergedSpendUsd: number;
  repoName: string;
  repoOwner: string;
  revertRate: number;
};

// Per-repo ROI quality: cost per merged PR alongside the outcome signals delivery's
// top-repo table omits (revert rate, CI-clean rate). Ordered by spend so the
// highest-investment repos surface first.
export async function getRoiByRepo(since: Date, limit = 10): Promise<RepoRoiRow[]> {
  const rows = await getPrisma().$queryRaw<
    {
      clean_merged_prs: bigint;
      merged_prs: bigint;
      merged_spend: number | null;
      repo_name: string;
      repo_owner: string;
      reverted_prs: bigint;
    }[]
  >(Prisma.sql`
    SELECT
      r.github_owner                                                                 AS repo_owner,
      r.github_name                                                                  AS repo_name,
      COUNT(pr.github_id) FILTER (WHERE pr.state = 'MERGED')                          AS merged_prs,
      COALESCE(SUM(prr.total_cost_usd) FILTER (WHERE pr.state = 'MERGED'), 0)         AS merged_spend,
      COUNT(pr.github_id) FILTER (WHERE pr.reverted_at IS NOT NULL)                   AS reverted_prs,
      COUNT(pr.github_id) FILTER (
        WHERE pr.state = 'MERGED' AND COALESCE(prr.check_failures_count, 0) = 0
      )                                                                              AS clean_merged_prs
    FROM repos r
    JOIN pull_requests pr
      ON pr.repo_id = r.id AND pr.opened_at >= ${since}
    LEFT JOIN pr_rollups prr
      ON prr.repo_id = pr.repo_id AND prr.pr_number = pr.pr_number
    GROUP BY r.id, r.github_owner, r.github_name
    HAVING COUNT(pr.github_id) FILTER (WHERE pr.state = 'MERGED') > 0
    ORDER BY merged_spend DESC
    LIMIT ${limit}
  `);

  return rows.map((row) => {
    const merged = Number(row.merged_prs);
    const mergedSpend = Number(row.merged_spend ?? 0);
    const clean = Number(row.clean_merged_prs);
    return {
      ciCleanRate: merged > 0 ? clean / merged : 0,
      costPerMergedPr: merged > 0 ? mergedSpend / merged : 0,
      mergedPrs: merged,
      mergedSpendUsd: mergedSpend,
      repoName: row.repo_name,
      repoOwner: row.repo_owner,
      revertRate: merged > 0 ? Number(row.reverted_prs) / merged : 0,
    };
  });
}
