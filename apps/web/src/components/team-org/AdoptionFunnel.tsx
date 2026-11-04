import { Card } from '@/components/ui';
import { Delta } from '@/components/ui/Stat';

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
  const rows = [
    { delta: null, label: 'Total users (ever)', value: everUsers },
    { delta: active30dDelta, label: 'Active last 30d', value: active30d },
    { delta: null, label: 'Active last 7d', value: active7d },
    { delta: null, label: 'New this month', value: newThisMonth },
  ];

  return (
    <Card title="Adoption funnel" contentClassName="space-y-3">
      <div className="space-y-2">
        {rows.map(({ label, value, delta }) => (
          <div key={label} className="flex justify-between">
            <span className="text-sm text-text-2">{label}</span>
            <div className="flex items-baseline gap-2">
              <span className="w-12 text-right font-mono font-semibold text-text">{value}</span>
              <span className="w-14 text-left">
                {delta !== null && <Delta value={delta} inverted={false} />}
              </span>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
