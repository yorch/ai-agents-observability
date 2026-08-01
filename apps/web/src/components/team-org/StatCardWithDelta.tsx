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
      colorClass = 'text-text-3';
    } else if (isPositive) {
      colorClass = invertColor ? 'text-crit' : 'text-good';
    } else {
      colorClass = invertColor ? 'text-good' : 'text-crit';
    }

    return (
      <div
        className={`ml-2 inline-flex rounded-full bg-surface-2 px-2 py-0.5 text-xs font-mono ${colorClass}`}
      >
        {percentText}
      </div>
    );
  };

  return (
    <div className="rounded-lg border border-border bg-surface p-4 space-y-1">
      <p className="text-xs text-text-2">{label}</p>
      <div className="flex items-baseline gap-1">
        <p className="text-2xl font-semibold text-text">{value}</p>
        {renderDelta()}
      </div>
    </div>
  );
}
