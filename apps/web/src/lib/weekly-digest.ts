import type { ScopedTrendPoint } from './trend-queries';

export type WeekDigest = {
  start: string;
  end: string;
  sessions: number;
  costUsd: number;
  peak: string;
};

function monday(date: Date): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() - ((result.getUTCDay() + 6) % 7));
  result.setUTCHours(0, 0, 0, 0);
  return result;
}

export function completeWeeks(points: ScopedTrendPoint[], now = new Date()): WeekDigest[] {
  const byWeek = new Map<string, WeekDigest>();
  for (const point of points) {
    const start = monday(point.day);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 6);
    const key = start.toISOString().slice(0, 10);
    const existing = byWeek.get(key) ?? {
      costUsd: 0,
      end: end.toISOString().slice(0, 10),
      peak: point.day.toISOString().slice(0, 10),
      sessions: 0,
      start: key,
    };
    existing.costUsd += point.costUsd;
    existing.sessions += point.sessionCount;
    const peakPoint = points.find(
      (candidate) => candidate.day.toISOString().slice(0, 10) === existing.peak,
    );
    if (!peakPoint || point.sessionCount > peakPoint.sessionCount) {
      existing.peak = point.day.toISOString().slice(0, 10);
    }
    byWeek.set(key, existing);
  }
  const today = new Date(now);
  today.setUTCHours(0, 0, 0, 0);
  return [...byWeek.values()]
    .filter((week) => new Date(`${week.end}T00:00:00.000Z`) < today)
    .sort((a, b) => b.start.localeCompare(a.start));
}
