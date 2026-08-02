import { Segmented, SegmentedLink } from '@/components/ui';

export const DAYS_OPTS = [7, 30, 90] as const;
export type Days = (typeof DAYS_OPTS)[number];

export function parseDays(raw: string | undefined): Days {
  const n = Number(raw);
  return (DAYS_OPTS as readonly number[]).includes(n) ? (n as Days) : 7;
}

/** Trailing-window picker for the `/me` pages. Navigates; no client JS. */
export function DaysSelector({ basePath, current }: { basePath: string; current: Days }) {
  return (
    <Segmented label="Time range">
      {DAYS_OPTS.map((d) => (
        <SegmentedLink key={d} href={`${basePath}?days=${d}`} selected={current === d}>
          {d}d
        </SegmentedLink>
      ))}
    </Segmented>
  );
}
