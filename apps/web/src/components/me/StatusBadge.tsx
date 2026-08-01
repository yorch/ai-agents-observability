const STATUS_COLORS: Record<string, string> = {
  ABANDONED: 'bg-warn-soft text-warn',
  ACTIVE: 'bg-good-soft text-good',
  abandoned: 'bg-warn-soft text-warn',
  active: 'bg-good-soft text-good',
  COMPLETED: 'bg-accent/15 text-accent',
  CRASHED: 'bg-crit-soft text-crit',
  completed: 'bg-accent/15 text-accent',
  crashed: 'bg-crit-soft text-crit',
  TIMED_OUT: 'bg-warn-soft text-warn',
  timed_out: 'bg-warn-soft text-warn',
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
