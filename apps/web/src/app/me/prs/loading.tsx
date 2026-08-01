// Skeleton blocks sit one surface step above whatever they are on: `surface-2`
// on the page ground, `surface-3` inside a card. `bg-surface` would be
// invisible in light mode, where the card surface is white on a near-white
// canvas.
export default function PRsLoading() {
  return (
    <div className="animate-pulse space-y-6">
      <div className="h-8 w-48 rounded bg-surface-2" />

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="h-20 rounded-lg border border-border bg-surface" />
        ))}
      </div>

      {/* Filter bar */}
      <div className="flex gap-3">
        <div className="h-9 w-36 rounded-md bg-surface-2" />
        <div className="h-9 w-20 rounded-md bg-surface-2" />
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-lg border border-border bg-surface">
        <div className="h-10 border-b border-border bg-surface-2" />
        {[...Array(8)].map((_, i) => (
          <div
            key={i}
            className="flex h-14 items-center gap-4 border-b border-border-subtle px-4 py-3 last:border-0"
          >
            <div className="h-4 w-48 rounded bg-surface-2" />
            <div className="h-3 w-24 rounded bg-surface-3" />
            <div className="ml-auto h-5 w-14 rounded-full bg-surface-2" />
          </div>
        ))}
      </div>
    </div>
  );
}
