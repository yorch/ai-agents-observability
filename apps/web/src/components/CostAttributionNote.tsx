import type { AttributionCoverage } from '@/lib/attribution-coverage';
import { fmtPct } from '@/lib/fmt';

/**
 * The caption that has to sit under every attributed-cost table (P14-004).
 *
 * It carries three things a reader cannot get from the numbers themselves:
 *
 * 1. **What the two columns mean.** "Turn share" is the issuing turn's cost
 *    split across the tool calls it made; "Downstream" is the input-side cost
 *    that tool's output added to the *following* turn.
 * 2. **That they are not additive.** They are two readings of the same dollars,
 *    so a reader who mentally sums the columns gets a number that double-counts.
 *    Saying so in the caption is cheaper than every future reader rediscovering
 *    it, and this is the one place both columns are visible at once.
 * 3. **Coverage.** Attribution requires per-turn linkage from the agent adapter.
 *    Without it the columns are NULL and render as a dash. A page that showed
 *    "$0.00" instead would be presenting a gap in capture as a measurement —
 *    exactly the fiction this work exists to remove — so the fraction of
 *    sessions that *can* be attributed is stated next to the numbers.
 *
 * Shared by /org, /team and /me because the claim is identical on all three and
 * three copies of a caption about money is three chances to drift.
 */
export function CostAttributionNote({
  className,
  coverage,
}: {
  className?: string;
  coverage: AttributionCoverage;
}) {
  return (
    <div className={className}>
      <p className="text-xs text-text-3">
        <span className="text-text-2">Turn share</span> divides each assistant turn&rsquo;s cost
        evenly across the tool calls that turn issued.{' '}
        <span className="text-text-2">Downstream</span> is the input-side cost that a tool&rsquo;s
        output added to the next turn, apportioned by output size — an approximation, since bytes
        only stand in for tokens. The two read the <em>same</em> dollars from different ends, so
        they are not meant to be added together.
      </p>
      <p className="mt-1 text-xs text-text-3">
        <CoverageSentence coverage={coverage} />
      </p>
    </div>
  );
}

function CoverageSentence({ coverage }: { coverage: AttributionCoverage }) {
  if (coverage.totalSessions === 0 || coverage.ratio === null) {
    return <>No sessions in this window, so there is nothing to attribute.</>;
  }
  if (coverage.linkedSessions === 0) {
    return (
      <>
        No session in this window reports per-turn linkage yet, so every attributed figure reads
        &ldquo;—&rdquo;. That is a gap in capture, not a cost of zero.
      </>
    );
  }
  return (
    <>
      Attribution covers{' '}
      <span className="font-mono text-text-2">
        {coverage.linkedSessions.toLocaleString()}/{coverage.totalSessions.toLocaleString()}
      </span>{' '}
      sessions ({fmtPct(coverage.ratio)}) — the ones whose agent reported per-turn linkage. Anything
      outside that reads &ldquo;—&rdquo; rather than a cost of zero.
    </>
  );
}
