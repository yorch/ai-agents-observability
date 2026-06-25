const STATUS_COLORS: Record<string, string> = {
  ABANDONED: 'bg-yellow-500/15 text-yellow-400',
  ACTIVE: 'bg-green-500/15 text-green-400',
  abandoned: 'bg-yellow-500/15 text-yellow-400',
  active: 'bg-green-500/15 text-green-400',
  COMPLETED: 'bg-accent/15 text-accent',
  CRASHED: 'bg-red-500/15 text-red-400',
  completed: 'bg-accent/15 text-accent',
  crashed: 'bg-red-500/15 text-red-400',
  TIMED_OUT: 'bg-orange-500/15 text-orange-400',
  timed_out: 'bg-orange-500/15 text-orange-400',
};

export function StatusBadge({ status }: { status: string }) {
  const color = STATUS_COLORS[status] ?? 'bg-surface-2 text-text-3';
  return (
    <span
      className={`rounded px-2 py-0.5 text-xs font-medium font-mono uppercase tracking-wide ${color}`}
    >
      {status.toLowerCase()}
    </span>
  );
}
