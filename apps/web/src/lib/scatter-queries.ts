import { Prisma } from '@ai-agents-observability/db';
import { getPrisma } from './prisma';

export type CostDurationPoint = {
  costUsd: number;
  durationSeconds: number;
  sessionCount: number;
};

type RawPoint = { cost_usd: string | number; duration_seconds: number };

function bucket(value: number, step: number): number {
  return Math.max(step, Math.round(value / step) * step);
}

function mapRows(rows: RawPoint[], aggregate: boolean): CostDurationPoint[] {
  const grouped = new Map<string, CostDurationPoint>();
  for (const row of rows) {
    const durationSeconds = aggregate
      ? bucket(Number(row.duration_seconds), 300)
      : Number(row.duration_seconds);
    const costUsd = aggregate ? bucket(Number(row.cost_usd), 0.05) : Number(row.cost_usd);
    if (!Number.isFinite(durationSeconds) || !Number.isFinite(costUsd) || durationSeconds <= 0) {
      continue;
    }
    const key = `${durationSeconds}:${costUsd}`;
    const point = grouped.get(key);
    if (point) {
      point.sessionCount += 1;
    } else {
      grouped.set(key, { costUsd, durationSeconds, sessionCount: 1 });
    }
  }
  return [...grouped.values()].sort(
    (a, b) => a.durationSeconds - b.durationSeconds || a.costUsd - b.costUsd,
  );
}

/** Cost/duration observations. Team and org callers receive aggregate buckets, never member rows. */
export async function getUserCostDuration(
  userId: string,
  since: Date,
): Promise<CostDurationPoint[]> {
  const rows = await getPrisma().$queryRaw<RawPoint[]>(Prisma.sql`
    SELECT total_cost_usd AS cost_usd,
           EXTRACT(EPOCH FROM (ended_at - started_at)) AS duration_seconds
    FROM interactive_sessions
    WHERE user_id = ${userId}::uuid AND run_kind = 'INTERACTIVE'
      AND started_at >= ${since} AND ended_at IS NOT NULL
      AND ended_at > started_at AND total_cost_usd >= 0
    ORDER BY started_at DESC LIMIT 500
  `);
  return mapRows(rows, false);
}

export async function getTeamCostDuration(
  visibleIds: string[],
  since: Date,
): Promise<CostDurationPoint[]> {
  if (visibleIds.length === 0) {
    return [];
  }
  const ids = Prisma.join(visibleIds.map((id) => Prisma.sql`${id}::uuid`));
  const rows = await getPrisma().$queryRaw<RawPoint[]>(Prisma.sql`
    SELECT total_cost_usd AS cost_usd,
           EXTRACT(EPOCH FROM (ended_at - started_at)) AS duration_seconds
    FROM interactive_sessions
    WHERE user_id IN (${ids}) AND run_kind = 'INTERACTIVE'
      AND started_at >= ${since} AND ended_at IS NOT NULL
      AND ended_at > started_at AND total_cost_usd >= 0
    LIMIT 10000
  `);
  return mapRows(rows, true);
}

export async function getOrgCostDuration(since: Date): Promise<CostDurationPoint[]> {
  const rows = await getPrisma().$queryRaw<RawPoint[]>(Prisma.sql`
    SELECT s.total_cost_usd AS cost_usd,
           EXTRACT(EPOCH FROM (s.ended_at - s.started_at)) AS duration_seconds
    FROM interactive_sessions s
    JOIN users u ON u.id = s.user_id AND u.deactivated_at IS NULL
    LEFT JOIN visibility_policies vp ON vp.user_id = u.id
    WHERE s.run_kind = 'INTERACTIVE' AND s.started_at >= ${since}
      AND s.ended_at IS NOT NULL AND s.ended_at > s.started_at
      AND s.total_cost_usd >= 0 AND COALESCE(vp.share_metadata_with_org, true) = true
    LIMIT 10000
  `);
  return mapRows(rows, true);
}
