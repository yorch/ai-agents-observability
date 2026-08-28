export type ReportRange = {
  days: number;
  start: Date;
  end: Date;
  timezone: string;
  from: string;
  to: string;
};

const DAY = 86_400_000;

export function parseReportRange(
  params: { range?: string; from?: string; to?: string; tz?: string },
  now = new Date(),
): ReportRange {
  const timezone = params.tz && isValidTimezone(params.tz) ? params.tz : 'UTC';
  const end = params.to ? parseDate(params.to, true) : now;
  const start = params.from
    ? parseDate(params.from, false)
    : new Date(end.getTime() - (allowedDays(params.range) ?? 30) * DAY);
  const boundedEnd = end > now ? now : end;
  const boundedStart =
    start < new Date(boundedEnd.getTime() - 366 * DAY)
      ? new Date(boundedEnd.getTime() - 366 * DAY)
      : start;
  const days = Math.max(1, Math.ceil((boundedEnd.getTime() - boundedStart.getTime()) / DAY));
  return {
    days,
    end: boundedEnd,
    from: boundedStart.toISOString().slice(0, 10),
    start: boundedStart,
    timezone,
    to: boundedEnd.toISOString().slice(0, 10),
  };
}

export function allowedDays(raw?: string): number | undefined {
  const days = Number(raw);
  return [7, 30, 90].includes(days) ? days : undefined;
}

function parseDate(raw: string, end: boolean): Date {
  const value = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? `${raw}T${end ? '23:59:59.999' : '00:00:00.000'}Z`
    : raw;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}
