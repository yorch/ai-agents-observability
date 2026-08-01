export function AdoptionFunnel({
  funnel: { everUsers, active30d, active7d, newThisMonth, active30dDelta },
}: {
  funnel: {
    everUsers: number;
    active30d: number;
    active7d: number;
    newThisMonth: number;
    active30dDelta: number | null;
  };
}) {
  const renderDeltaBadge = (delta: number | null) => {
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
      colorClass = 'text-good';
    } else {
      colorClass = 'text-crit';
    }

    return <span className={`ml-2 inline text-xs font-mono ${colorClass}`}>{percentText}</span>;
  };

  const rows = [
    { delta: null, label: 'Total users (ever)', value: everUsers },
    { delta: active30dDelta, label: 'Active last 30d', value: active30d },
    { delta: null, label: 'Active last 7d', value: active7d },
    { delta: null, label: 'New this month', value: newThisMonth },
  ];

  return (
    <div className="rounded-lg border border-border bg-surface p-4 space-y-3">
      <h2 className="text-sm font-semibold text-text-2">Adoption funnel</h2>
      <div className="space-y-2">
        {rows.map(({ label, value, delta }) => (
          <div key={label} className="flex justify-between">
            <span className="text-sm text-text-2">{label}</span>
            <div className="flex items-baseline">
              <span className="font-semibold text-text font-mono">{value}</span>
              {renderDeltaBadge(delta)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
