import { Prisma } from '@ai-agents-observability/db';
import { getPrisma } from './prisma';

export type TrendModelPoint = { costUsd: number; model: string; sessionCount: number };
export type ScopedTrendPoint = {
  day: Date;
  costUsd: number;
  sessionCount: number;
  models: TrendModelPoint[];
};

export type ConcurrencyPoint = {
  day: Date;
  sessionCount: number;
  peakConcurrent: number;
  parallelSessionCount: number;
  parallelShare: number;
};

type SessionInterval = { startedAt: Date; endedAt: Date };

/** Aggregate interval overlap without exposing session identities to callers. */
export function computeConcurrency(
  rows: SessionInterval[],
  since: Date,
  now = new Date(),
): ConcurrencyPoint[] {
  const endDay = new Date(now);
  endDay.setUTCHours(0, 0, 0, 0);
  const startDay = new Date(since);
  startDay.setUTCHours(0, 0, 0, 0);
  const output: ConcurrencyPoint[] = [];
  for (let day = new Date(startDay); day <= endDay; day.setUTCDate(day.getUTCDate() + 1)) {
    const dayStart = new Date(day);
    const dayEnd = new Date(day);
    dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
    const intervals = rows
      .map((row) => ({
        end: new Date(Math.min(row.endedAt.getTime(), dayEnd.getTime())),
        start: new Date(Math.max(row.startedAt.getTime(), dayStart.getTime())),
      }))
      .filter((row) => row.start < row.end);
    const events = intervals
      .flatMap((row) => [
        { at: row.start.getTime(), delta: 1 },
        { at: row.end.getTime(), delta: -1 },
      ])
      .sort((a, b) => a.at - b.at || a.delta - b.delta);
    let active = 0;
    let peakConcurrent = 0;
    for (const event of events) {
      active += event.delta;
      peakConcurrent = Math.max(peakConcurrent, active);
    }
    let parallelSessionCount = 0;
    for (let i = 0; i < intervals.length; i += 1) {
      const current = intervals[i];
      if (
        current &&
        intervals.some(
          (other, j) => i !== j && current.start < other.end && current.end > other.start,
        )
      ) {
        parallelSessionCount += 1;
      }
    }
    output.push({
      day: new Date(day),
      parallelSessionCount,
      parallelShare: intervals.length ? parallelSessionCount / intervals.length : 0,
      peakConcurrent,
      sessionCount: intervals.length,
    });
  }
  return output;
}

type IntervalRow = { started_at: Date; ended_at: Date | null; last_event_at: Date };

function mapIntervals(rows: IntervalRow[], now = new Date()): SessionInterval[] {
  return rows.map((row) => ({
    endedAt: new Date(Math.min((row.ended_at ?? row.last_event_at).getTime(), now.getTime())),
    startedAt: row.started_at,
  }));
}

async function getConcurrency(
  where: ReturnType<typeof Prisma.sql>,
  since: Date,
): Promise<ConcurrencyPoint[]> {
  const rows = await getPrisma().$queryRaw<IntervalRow[]>(Prisma.sql`
    SELECT started_at, ended_at, last_event_at
    FROM interactive_sessions
    WHERE started_at >= ${since} AND ${where}
  `);
  return computeConcurrency(mapIntervals(rows), since);
}

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

export async function getUserConcurrency(userId: string, since: Date): Promise<ConcurrencyPoint[]> {
  return getConcurrency(Prisma.sql`user_id = ${userId}::uuid`, since);
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

export async function getTeamConcurrency(
  visibleIds: string[],
  since: Date,
): Promise<ConcurrencyPoint[]> {
  if (visibleIds.length === 0) {
    return computeConcurrency([], since);
  }
  const ids = Prisma.join(visibleIds.map((id) => Prisma.sql`${id}::uuid`));
  return getConcurrency(Prisma.sql`user_id IN (${ids})`, since);
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

export async function getOrgConcurrency(since: Date): Promise<ConcurrencyPoint[]> {
  const rows = await getPrisma().$queryRaw<IntervalRow[]>(Prisma.sql`
    SELECT s.started_at, s.ended_at, s.last_event_at
    FROM interactive_sessions s
    JOIN users u ON u.id = s.user_id AND u.deactivated_at IS NULL
    LEFT JOIN visibility_policies vp ON vp.user_id = u.id
    WHERE s.started_at >= ${since} AND COALESCE(vp.share_metadata_with_org, true) = true
  `);
  return computeConcurrency(mapIntervals(rows), since);
}
