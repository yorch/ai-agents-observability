import { Segmented, SegmentedLink } from '@/components/ui';

const RANGES = [7, 30, 90] as const;
export type Range = (typeof RANGES)[number];

/**
 * Trailing-window picker for the team and org dashboards.
 *
 * Server-rendered links, not a client component. Every route that uses it takes
 * `range` as its only search param, so `?range=N` reproduces what the previous
 * `useSearchParams` + `router.replace` version did — and this was the app's only
 * `useSearchParams` caller, which forced a client-side-rendering bailout on all
 * six of those routes for what is three links.
 */
export function DateRangePicker({ range }: { range: Range }) {
  return (
    <Segmented label="Date range">
      {RANGES.map((value) => (
        <SegmentedLink key={value} href={`?range=${value}`} selected={range === value}>
          {value}d
        </SegmentedLink>
      ))}
    </Segmented>
  );
}
