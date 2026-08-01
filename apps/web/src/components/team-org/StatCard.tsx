type StatCardProps = {
  accent?: 'amber' | 'green' | 'red';
  label: string;
  // Small mono text below the value (e.g. unit hints like "target: 40–60%")
  note?: string;
  // Small regular text below the value (e.g. "vs. last period")
  sub?: string;
  value: string;
  // Shorthand for accent="amber"
  warn?: boolean;
};

export function StatCard({ accent, label, note, sub, value, warn }: StatCardProps) {
  const effectiveAccent = accent ?? (warn ? 'amber' : undefined);
  const valueCls =
    effectiveAccent === 'red'
      ? 'text-crit'
      : effectiveAccent === 'amber'
        ? 'text-warn'
        : effectiveAccent === 'green'
          ? 'text-good'
          : '';
  return (
    <div className="space-y-1 rounded-lg border border-border bg-surface p-4">
      <p className="text-xs uppercase tracking-wider text-text-3">{label}</p>
      <p className={`font-mono text-2xl font-semibold ${valueCls}`}>{value}</p>
      {sub && <p className="text-xs text-text-3">{sub}</p>}
      {note && <p className="text-[10px] font-mono text-text-3">{note}</p>}
    </div>
  );
}
