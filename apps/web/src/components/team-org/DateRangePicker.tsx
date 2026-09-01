import { Segmented, SegmentedLink } from '@/components/ui';

const RANGES = [7, 30, 90] as const;
export type Range = (typeof RANGES)[number];

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
  preserve,
  range,
}: {
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
      {RANGES.map((value) => {
        const query = new URLSearchParams(carried);
        query.set('range', String(value));
        return (
          <SegmentedLink key={value} href={`?${query.toString()}`} selected={range === value}>
            {value}d
          </SegmentedLink>
        );
      })}
    </Segmented>
  );
}
