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
      ? 'text-red-400'
      : effectiveAccent === 'amber'
        ? 'text-yellow-300'
        : effectiveAccent === 'green'
          ? 'text-emerald-400'
          : '';
  return (
    <div className="space-y-1 rounded-lg border border-white/10 bg-white/5 p-4">
      <p className="text-xs uppercase tracking-wider text-white/40">{label}</p>
      <p className={`font-mono text-2xl font-semibold ${valueCls}`}>{value}</p>
      {sub && <p className="text-xs text-white/30">{sub}</p>}
      {note && <p className="text-[10px] font-mono text-white/30">{note}</p>}
    </div>
  );
}
