import { Segmented, SegmentedLink } from '@/components/ui';

/** The default option set: the scoped dashboards all reason in these terms. */
export const RANGES = [7, 30, 90] as const;

/**
 * The trailing-window pages (`/me`, `/me/insights`) also offer 1y and 2y.
 *
 * Those exist for imported history: `apps/hook`'s `import` preserves each
 * transcript's original timestamps, so a bulk import lands months or years in
 * the past. On one deployment a 90-day cap put 57% of an 8,759-session import
 * out of reach of every page except the session list, which has no default date
 * filter. Kept numeric rather than gaining an "All": both consumers derive the
 * *preceding* period from this value for the period-over-period deltas, and
 * "the period before all of history" has no meaning.
 */
export const LONG_RANGES = [7, 30, 90, 365, 730] as const;

export type Range = (typeof LONG_RANGES)[number];

const LABELS: Record<Range, string> = {
  7: '7d',
  30: '30d',
  90: '90d',
  365: '1y',
  730: '2y',
};

/**
 * Trailing-window picker for the team and org dashboards.
 *
 * Server-rendered links, not a client component — this was the app's only
 * `useSearchParams` caller, which forced a client-side-rendering bailout on
 * every route that used it for what is three links.
 *
 * `preserve` carries the search params that should survive a range click. The
 * hrefs used to be a bare `?range=N`, which replaces the entire query string;
 * that was safe while every caller took `range` as its only param, and stopped
 * being safe when the trends pages added a timezone and a repo filter. Nothing
 * enforced the assumption, so clicking a chip silently dropped them.
 *
 * `from`/`to` are deliberately NOT preserved: picking a preset *means* "trailing
 * N days", so it has to clear a custom window rather than fight it. Pass
 * `range={null}` while a custom window is active so no chip claims to be
 * selected.
 */
export function DateRangePicker({
  options = RANGES,
  preserve,
  range,
}: {
  /** Defaults to 7/30/90; pass LONG_RANGES on the trailing-window pages. */
  options?: readonly Range[] | undefined;
  preserve?: Record<string, string | undefined> | undefined;
  range: Range | null;
}) {
  const carried = new URLSearchParams();
  for (const [key, value] of Object.entries(preserve ?? {})) {
    if (value) {
      carried.set(key, value);
    }
  }

  return (
    <Segmented label="Date range">
      {options.map((value) => {
        const query = new URLSearchParams(carried);
        query.set('range', String(value));
        return (
          <SegmentedLink key={value} href={`?${query.toString()}`} selected={range === value}>
            {LABELS[value]}
          </SegmentedLink>
        );
      })}
    </Segmented>
  );
}
