import { Badge, SeriesBadge } from '@/components/ui';

/**
 * Pull-request state. `merged` keeps the purple GitHub has trained everyone to
 * read as merged rather than borrowing a status tone; the rest are genuine
 * states and take theirs.
 */
export function PrStateBadge({ state }: { state: string }) {
  if (state === 'merged') {
    return <SeriesBadge index={3}>merged</SeriesBadge>;
  }
  const tone = state === 'open' ? 'good' : state === 'closed' ? 'crit' : 'neutral';
  return <Badge tone={tone}>{state}</Badge>;
}
