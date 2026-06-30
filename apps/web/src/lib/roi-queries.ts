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
      COUNT(*) FILTER (WHERE COALESCE(prr.check_failures_count, 0) = 0)   AS clean_count,
      AVG(prr.total_cost_usd) FILTER (WHERE COALESCE(prr.check_failures_count, 0) = 0)
                                                                          AS clean_avg_cost,
      COUNT(*) FILTER (WHERE COALESCE(prr.check_failures_count, 0) > 0)   AS failed_count,
      AVG(prr.total_cost_usd) FILTER (WHERE COALESCE(prr.check_failures_count, 0) > 0)
                                                                          AS failed_avg_cost
    FROM pull_requests pr
    JOIN pr_rollups prr
      ON prr.repo_id = pr.repo_id AND prr.pr_number = pr.pr_number
    WHERE pr.state = 'MERGED' AND pr.merged_at >= ${since}
  `);

  const r = rows[0];
  return {
    cleanAvgCost: Number(r?.clean_avg_cost ?? 0),
    cleanCount: Number(r?.clean_count ?? 0),
    failedAvgCost: Number(r?.failed_avg_cost ?? 0),
    failedCount: Number(r?.failed_count ?? 0),
  };
}

export type JiraSpendRow = {
  jiraKey: string;
  mergedPrs: number;
  prCount: number;
  totalCostUsd: number;
};

// Cost allocation by Jira initiative: which tracked pieces of work are absorbing
// the most agent spend. jira_key is extracted from the PR branch/title (P5-004).
export async function getSpendByJiraKey(since: Date, limit = 15): Promise<JiraSpendRow[]> {
  const rows = await getPrisma().$queryRaw<
    { jira_key: string; merged_prs: bigint; pr_count: bigint; total_cost: number | null }[]
  >(Prisma.sql`
    SELECT
      pr.jira_key                                              AS jira_key,
      COUNT(pr.github_id)                                      AS pr_count,
      COUNT(pr.github_id) FILTER (WHERE pr.state = 'MERGED')   AS merged_prs,
      COALESCE(SUM(prr.total_cost_usd), 0)                     AS total_cost
    FROM pull_requests pr
    LEFT JOIN pr_rollups prr
      ON prr.repo_id = pr.repo_id AND prr.pr_number = pr.pr_number
    WHERE pr.opened_at >= ${since} AND pr.jira_key IS NOT NULL
    GROUP BY pr.jira_key
    ORDER BY total_cost DESC
    LIMIT ${limit}
  `);

  return rows.map((r) => ({
    jiraKey: r.jira_key,
    mergedPrs: Number(r.merged_prs),
    prCount: Number(r.pr_count),
    totalCostUsd: Number(r.total_cost ?? 0),
  }));
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
