import { Prisma } from '@ai-agents-observability/db';
import { getPrisma } from './prisma';

export type CostDurationPoint = {
  costUsd: number;
  durationSeconds: number;
  sessionCount: number;
  /** Aggregate buckets only: the bucket spans [costUsd, costUsd + costStepUsd). */
  costStepUsd?: number;
  /** Aggregate buckets only: the bucket spans [durationSeconds, durationSeconds + step). */
  durationStepSeconds?: number;
};

export type RawPoint = { cost_usd: string | number; duration_seconds: number };
export type ScatterOptions = { until?: Date | undefined; repo?: string | undefined };

function repoFilter(alias: string, repo?: string) {
  return repo
    ? Prisma.sql`AND EXISTS (SELECT 1 FROM repos r WHERE r.id = ${Prisma.raw(`${alias}.repo_id`)} AND CONCAT(r.github_owner, '/', r.github_name) = ${repo})`
    : Prisma.empty;
}

/** Round to a 1/2/5 x 10^k step at or above `raw`, so axis ticks stay readable. */
export function niceStep(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) {
    return 1;
  }
  const exp = 10 ** Math.floor(Math.log10(raw));
  const f = raw / exp;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return Number((nice * exp).toPrecision(12));
}

/** Human-friendly duration steps (seconds): 5m, 10m, 15m, 30m, 1h, 2h, 4h, 8h, 12h, 24h. */
export const DURATION_LADDER_S = [300, 600, 900, 1800, 3600, 7200, 14400, 28800, 43200, 86400];

/** Smallest ladder rung at or above `raw`, so bucket labels read as clock times. */
export function ladderStep(raw: number, ladder: readonly number[] = DURATION_LADDER_S): number {
  const first = ladder[0] ?? 1;
  return ladder.find((rung) => rung >= raw) ?? ladder[ladder.length - 1] ?? first;
}

function p95Of(values: number[]): number {
  const sorted = values.filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
}

/**
 * Cost bucket width derived from the population: the 95th percentile spread
 * over about 20 buckets, never finer than `floor`. Data-derived (not a
 * constant) so a cheap fleet is not flattened onto one line, and floored so a
 * tiny population cannot be bucketed finely enough to re-identify a session.
 */
export function bucketStep(values: number[], floor: number): number {
  const p95 = p95Of(values);
  return p95 > 0 ? Math.max(floor, niceStep(p95 / 20)) : floor;
}

/** Duration bucket width: p95 over about 20 buckets, snapped up to the human ladder. */
export function durationBucketStep(values: number[]): number {
  return ladderStep(Math.max(DURATION_STEP_FLOOR_S, p95Of(values) / 20));
}

/**
 * Lower edge of the bucket containing `value`. Deliberately no floor-to-one-step
 * (a $0.01 session is not a fabricated $0.05 one), and lower-edge rather than
 * rounded so every bucket is exactly [edge, edge + step) and is labelled so.
 */
export function bucket(value: number, step: number): number {
  return Number((Math.floor(value / step + 1e-9) * step).toPrecision(12));
}

/** Aggregate buckets with fewer sessions than this are withheld from team/org views. */
export const MIN_BUCKET_SESSIONS = 3;

export const COST_STEP_FLOOR_USD = 0.05;
export const DURATION_STEP_FLOOR_S = 300;

/** Points plus the number of sessions withheld by small-bucket suppression. */
export type ScatterPoints = CostDurationPoint[] & { suppressedSessions?: number };

export function mapRows(rows: RawPoint[], aggregate: boolean): ScatterPoints {
  const costStep = aggregate
    ? bucketStep(
        rows.map((r) => Number(r.cost_usd)),
        COST_STEP_FLOOR_USD,
      )
    : 0;
  const durationStep = aggregate
    ? durationBucketStep(rows.map((r) => Number(r.duration_seconds)))
    : 0;
  const grouped = new Map<string, CostDurationPoint>();
  for (const row of rows) {
    const rawDuration = Number(row.duration_seconds);
    const durationSeconds = aggregate ? bucket(rawDuration, durationStep) : rawDuration;
    const costUsd = aggregate ? bucket(Number(row.cost_usd), costStep) : Number(row.cost_usd);
    if (!Number.isFinite(durationSeconds) || !Number.isFinite(costUsd) || rawDuration <= 0) {
      continue;
    }
    const key = `${durationSeconds}:${costUsd}`;
    const point = grouped.get(key);
    if (point) {
      point.sessionCount += 1;
    } else {
      grouped.set(key, {
        costUsd,
        durationSeconds,
        sessionCount: 1,
        ...(aggregate ? { costStepUsd: costStep, durationStepSeconds: durationStep } : {}),
      });
    }
  }
  let points = [...grouped.values()];
  let suppressed = 0;
  if (aggregate) {
    // Small-n suppression: a bucket of one or two sessions is an individual's
    // cost and duration to within a bucket width, which team/org views must not show.
    points = points.filter((p) => {
      if (p.sessionCount >= MIN_BUCKET_SESSIONS) {
        return true;
      }
      suppressed += p.sessionCount;
      return false;
    });
  }
  const sorted: ScatterPoints = points.sort(
    (a, b) => a.durationSeconds - b.durationSeconds || a.costUsd - b.costUsd,
  );
  if (aggregate) {
    sorted.suppressedSessions = suppressed;
  }
  return sorted;
}

/** Cost/duration observations. Team and org callers receive aggregate buckets, never member rows. */
export async function getUserCostDuration(
  userId: string,
  since: Date,
  options: ScatterOptions = {},
): Promise<CostDurationPoint[]> {
  const rows = await getPrisma().$queryRaw<RawPoint[]>(Prisma.sql`
    SELECT total_cost_usd AS cost_usd,
           EXTRACT(EPOCH FROM (ended_at - started_at)) AS duration_seconds
    FROM interactive_sessions
    WHERE user_id = ${userId}::uuid AND run_kind = 'INTERACTIVE'
      AND started_at >= ${since} AND started_at < ${options.until ?? new Date()} AND ended_at IS NOT NULL
      ${repoFilter('interactive_sessions', options.repo)}
      AND ended_at > started_at AND total_cost_usd >= 0
    ORDER BY started_at DESC LIMIT 500
  `);
  return mapRows(rows, false);
}

export async function getTeamCostDuration(
  visibleIds: string[],
  since: Date,
  options: ScatterOptions = {},
): Promise<ScatterPoints> {
  if (visibleIds.length === 0) {
    return [];
  }
  const ids = Prisma.join(visibleIds.map((id) => Prisma.sql`${id}::uuid`));
  const rows = await getPrisma().$queryRaw<RawPoint[]>(Prisma.sql`
    SELECT total_cost_usd AS cost_usd,
           EXTRACT(EPOCH FROM (ended_at - started_at)) AS duration_seconds
    FROM interactive_sessions
    WHERE user_id IN (${ids}) AND run_kind = 'INTERACTIVE'
      AND started_at >= ${since} AND started_at < ${options.until ?? new Date()} AND ended_at IS NOT NULL
      ${repoFilter('interactive_sessions', options.repo)}
      AND ended_at > started_at AND total_cost_usd >= 0
    LIMIT 10000
  `);
  return mapRows(rows, true);
}

export async function getOrgCostDuration(
  since: Date,
  options: ScatterOptions = {},
): Promise<ScatterPoints> {
  const rows = await getPrisma().$queryRaw<RawPoint[]>(Prisma.sql`
    SELECT s.total_cost_usd AS cost_usd,
           EXTRACT(EPOCH FROM (s.ended_at - s.started_at)) AS duration_seconds
    FROM interactive_sessions s
    JOIN users u ON u.id = s.user_id AND u.deactivated_at IS NULL
    LEFT JOIN visibility_policies vp ON vp.user_id = u.id
    WHERE s.run_kind = 'INTERACTIVE' AND s.started_at >= ${since} AND s.started_at < ${options.until ?? new Date()}
      AND s.ended_at IS NOT NULL AND s.ended_at > s.started_at
      AND s.total_cost_usd >= 0 AND COALESCE(vp.share_metadata_with_org, true) = true
      ${repoFilter('s', options.repo)}
    LIMIT 10000
  `);
  return mapRows(rows, true);
}
