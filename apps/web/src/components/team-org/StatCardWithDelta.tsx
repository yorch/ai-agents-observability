export function StatCardWithDelta({
  label,
  value,
  delta,
  invertColor = false,
}: {
  label: string;
  value: string;
  delta?: number | null;
  invertColor?: boolean;
}) {
  const renderDelta = () => {
    if (delta === null || delta === undefined) {
      return null;
    }

    const percentValue = Math.round(delta * 100);
    const isPositive = percentValue >= 0;
    const prefix = isPositive ? '+' : '';
    const percentText = `${prefix}${percentValue}%`;

    let colorClass: string;
    if (percentValue === 0) {
      colorClass = 'text-white/40';
    } else if (isPositive) {
      colorClass = invertColor ? 'text-red-400' : 'text-emerald-400';
    } else {
      colorClass = invertColor ? 'text-emerald-400' : 'text-red-400';
    }

    return (
      <div
        className={`ml-2 inline-flex rounded-full bg-white/10 px-2 py-0.5 text-xs font-mono ${colorClass}`}
      >
        {percentText}
      </div>
    );
  };

  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-1">
      <p className="text-xs text-white/50">{label}</p>
      <div className="flex items-baseline gap-1">
        <p className="text-2xl font-semibold text-white">{value}</p>
        {renderDelta()}
      </div>
    </div>
  );
}
