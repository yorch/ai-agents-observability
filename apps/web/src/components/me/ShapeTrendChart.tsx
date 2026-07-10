import type { WeeklyShapeBucket } from '@/lib/cohort-queries';

// Matches the segment colors in ShapeDistributionChart (not exported from
// there) so a shape reads the same color everywhere on /me/insights.
const SHAPE_COLOR: Record<string, string> = {
  debugging: 'bg-orange-400',
  exploratory: 'bg-blue-400',
  'focused-edit': 'bg-green-400',
  minimal: 'bg-surface-2',
  'multi-tool': 'bg-purple-400',
  planning: 'bg-sky-400',
};

const BAR_HEIGHT_PX = 96;
const MIN_WEEKS_WITH_DATA = 2;

// Per-user weekly session-shape mix — one 100%-stacked bar per week, segments
// sized by that week's proportion of each shape. Server component (pure
// render); the query already scopes to the current user.
export function ShapeTrendChart({ buckets }: { buckets: WeeklyShapeBucket[] }) {
  const weeksWithData = buckets.filter((b) =>
    Object.values(b.shapeCounts).some((count) => count > 0),
  );
  const shapesPresent = [...new Set(weeksWithData.flatMap((b) => Object.keys(b.shapeCounts)))].sort(
    (a, b) => (a < b ? -1 : 1),
  );

  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <h2 className="mb-1 text-xs font-semibold uppercase tracking-widest text-text-3">
        Shape mix by week
      </h2>
      <p className="mb-4 text-xs text-text-3">
        Session-shape mix by week — a shift toward implementation/focused-edit as you learn a
        codebase is a proficiency signal.
      </p>

      {weeksWithData.length < MIN_WEEKS_WITH_DATA ? (
        <p className="text-sm text-text-3">Not enough history yet.</p>
      ) : (
        <>
          <div className="flex items-end gap-1" style={{ height: BAR_HEIGHT_PX }}>
            {weeksWithData.map((bucket) => {
              const total = Object.values(bucket.shapeCounts).reduce((sum, c) => sum + c, 0);
              const label = new Date(bucket.weekStart).toLocaleDateString(undefined, {
                day: 'numeric',
                month: 'short',
              });
              return (
                <div key={bucket.weekStart} className="flex flex-1 flex-col items-center gap-1">
                  <div
                    className="flex w-full flex-col-reverse overflow-hidden rounded-sm"
                    style={{ height: BAR_HEIGHT_PX }}
                    title={`${label}: ${total} session${total === 1 ? '' : 's'}`}
                  >
                    {shapesPresent.map((shape) => {
                      const count = bucket.shapeCounts[shape] ?? 0;
                      if (count === 0) {
                        return null;
                      }
                      return (
                        <div
                          key={shape}
                          className={SHAPE_COLOR[shape] ?? 'bg-surface-2'}
                          style={{ height: `${(count / total) * 100}%` }}
                        />
                      );
                    })}
                  </div>
                  <span className="text-[9px] text-text-3">{label}</span>
                </div>
              );
            })}
          </div>
          <ul className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[10px]">
            {shapesPresent.map((shape) => (
              <li key={shape} className="flex items-center gap-1.5 text-text-2">
                <span
                  className={`inline-block h-2 w-2 rounded-full ${SHAPE_COLOR[shape] ?? 'bg-surface-2'}`}
                />
                {shape}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
