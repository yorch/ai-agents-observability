import { Segmented, SegmentedLink } from '@/components/ui';

// The long options exist for imported history. `apps/hook`'s `import` command
// preserves each transcript's original timestamps, so a bulk import lands
// months or years in the past — with a 90-day cap, most of what a developer
// just imported was reachable in the sessions list (which has no default date
// filter) and nowhere else. Kept numeric rather than adding an "All": every
// consumer also derives the *preceding* period from this to compute the
// period-over-period deltas, and "the period before all of history" has no
// meaning.
export const DAYS_OPTS = [7, 30, 90, 365, 730] as const;
export type Days = (typeof DAYS_OPTS)[number];

const DAYS_LABELS: Record<Days, string> = {
  7: '7d',
  30: '30d',
  90: '90d',
  365: '1y',
  730: '2y',
};

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
          {DAYS_LABELS[d]}
        </SegmentedLink>
      ))}
    </Segmented>
  );
}
