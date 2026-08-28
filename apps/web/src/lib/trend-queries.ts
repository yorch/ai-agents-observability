import { Prisma } from '@ai-agents-observability/db';
import { getPrisma } from './prisma';

export type TrendModelPoint = { costUsd: number; model: string; sessionCount: number };
export type ScopedTrendPoint = {
  day: Date;
  costUsd: number;
  sessionCount: number;
  models: TrendModelPoint[];
};

type RawRow = {
  day: Date;
  cost_usd: string | number;
  model: string | null;
  session_count: bigint;
};

function mapRows(rows: RawRow[]): ScopedTrendPoint[] {
  const byDay = new Map<string, ScopedTrendPoint>();
  for (const row of rows) {
    const day = new Date(row.day);
    const key = day.toISOString().slice(0, 10);
    let point = byDay.get(key);
    if (!point) {
      point = { costUsd: 0, day, models: [], sessionCount: 0 };
      byDay.set(key, point);
    }
    const costUsd = Number(row.cost_usd ?? 0);
    const sessionCount = Number(row.session_count ?? 0);
    point.costUsd += costUsd;
    point.sessionCount += sessionCount;
    const model = row.model ?? 'unknown';
    const existing = point.models.find((item) => item.model === model);
    if (existing) {
      existing.costUsd += costUsd;
      existing.sessionCount += sessionCount;
    } else {
      point.models.push({ costUsd, model, sessionCount });
    }
  }
  return [...byDay.values()].sort((a, b) => a.day.getTime() - b.day.getTime());
}

/** Daily spend, sessions, and model mix for one developer. */
export async function getUserTrends(userId: string, since: Date): Promise<ScopedTrendPoint[]> {
  const rows = await getPrisma().$queryRaw<RawRow[]>(Prisma.sql`
    SELECT date_trunc('day', started_at) AS day, primary_model AS model,
           COALESCE(SUM(total_cost_usd), 0) AS cost_usd, COUNT(*) AS session_count
    FROM interactive_sessions
    WHERE user_id = ${userId}::uuid AND started_at >= ${since}
    GROUP BY date_trunc('day', started_at), primary_model ORDER BY day ASC
  `);
  return mapRows(rows);
}

/** Daily spend, sessions, and model mix for the already visibility-filtered team members. */
export async function getTeamTrends(
  visibleIds: string[],
  since: Date,
): Promise<ScopedTrendPoint[]> {
  if (visibleIds.length === 0) {
    return [];
  }
  const ids = Prisma.join(visibleIds.map((id) => Prisma.sql`${id}::uuid`));
  const rows = await getPrisma().$queryRaw<RawRow[]>(Prisma.sql`
    SELECT date_trunc('day', started_at) AS day, primary_model AS model,
           COALESCE(SUM(total_cost_usd), 0) AS cost_usd, COUNT(*) AS session_count
    FROM interactive_sessions
    WHERE user_id IN (${ids}) AND started_at >= ${since}
    GROUP BY date_trunc('day', started_at), primary_model ORDER BY day ASC
  `);
  return mapRows(rows);
}

/** Daily org trend, applying the org metadata-sharing policy at the scan. */
export async function getOrgTrends(since: Date): Promise<ScopedTrendPoint[]> {
  const rows = await getPrisma().$queryRaw<RawRow[]>(Prisma.sql`
    SELECT date_trunc('day', s.started_at) AS day, s.primary_model AS model,
           COALESCE(SUM(s.total_cost_usd), 0) AS cost_usd, COUNT(*) AS session_count
    FROM interactive_sessions s
    JOIN users u ON u.id = s.user_id AND u.deactivated_at IS NULL
    LEFT JOIN visibility_policies vp ON vp.user_id = u.id
    WHERE s.started_at >= ${since} AND COALESCE(vp.share_metadata_with_org, true) = true
    GROUP BY date_trunc('day', s.started_at), s.primary_model ORDER BY day ASC
  `);
  return mapRows(rows);
}
