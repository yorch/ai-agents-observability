import { Badge } from '@/components/ui';

/**
 * Pull-request state. `merged` keeps the purple GitHub has trained everyone to
 * read as merged — a domain colour with its own token, not a chart series slot
 * that would move the next time the series palette is re-tuned.
 */
export function PrStateBadge({ state }: { state: string }) {
  if (state === 'merged') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-merged-line bg-merged-soft px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-merged">
        <span className="h-1 w-1 shrink-0 rounded-full bg-current" />
        merged
      </span>
    );
  }
  const tone = state === 'open' ? 'good' : state === 'closed' ? 'crit' : 'neutral';
  return <Badge tone={tone}>{state}</Badge>;
}
