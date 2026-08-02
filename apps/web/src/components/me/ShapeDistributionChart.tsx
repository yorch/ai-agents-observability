import { ShareBar } from '@/components/ui';
import { shapeBg } from './shape';

const SHAPE_DESC: Record<string, string> = {
  debugging: 'heavy execution, retries',
  exploratory: 'heavy reading, few edits',
  'focused-edit': 'concentrated edits',
  minimal: 'too few events to classify',
  'multi-tool': 'broad tool spread',
  planning: 'mostly conversation',
};

export function ShapeDistributionChart({ histogram }: { histogram: Record<string, number> }) {
  const entries = Object.entries(histogram).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((sum, [, count]) => sum + count, 0);

  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <h2 className="mb-4 text-xs font-semibold uppercase tracking-widest text-text-3">
        Session shapes
      </h2>

      {total === 0 ? (
        <p className="text-sm text-text-3">No classified sessions in this period.</p>
      ) : (
        <>
          <div className="mb-4">
            <ShareBar
              total={total}
              segments={entries.map(([label, count]) => ({
                className: shapeBg(label),
                key: label,
                title: `${label}: ${count}`,
                value: count,
              }))}
            />
          </div>
          <ul className="space-y-1.5 text-xs">
            {entries.map(([label, count]) => (
              <li key={label} className="flex items-center justify-between">
                <span className="flex items-center gap-2 text-text">
                  <span className={`inline-block h-2 w-2 rounded-full ${shapeBg(label)}`} />
                  {label}
                  <span className="text-text-3">— {SHAPE_DESC[label] ?? ''}</span>
                </span>
                <span className="text-text-2">{Math.round((count / total) * 100)}%</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
