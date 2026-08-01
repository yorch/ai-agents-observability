import { Badge, type BadgeTone } from '@/components/ui';

// Session status is a state, so it takes the status tones. Both casings appear
// in the data (the DB enum and the wire schema disagreed historically).
const STATUS_TONE: Record<string, BadgeTone> = {
  ABANDONED: 'warn',
  ACTIVE: 'good',
  COMPLETED: 'accent',
  CRASHED: 'crit',
  TIMED_OUT: 'warn',
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge tone={STATUS_TONE[status.toUpperCase()] ?? 'neutral'}>{status.toLowerCase()}</Badge>
  );
}
