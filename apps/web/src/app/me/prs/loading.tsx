export default function PRsLoading() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="h-8 w-48 rounded bg-white/10" />

      {/* Summary cards skeleton */}
      <div className="grid grid-cols-3 gap-4">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="h-20 rounded-lg bg-white/5" />
        ))}
      </div>

      {/* Filter bar skeleton */}
      <div className="flex gap-3">
        <div className="h-9 w-36 rounded-md bg-white/5" />
        <div className="h-9 w-20 rounded-md bg-white/5" />
      </div>

      {/* Table skeleton */}
      <div className="rounded-lg border border-white/10 bg-white/5 overflow-hidden">
        <div className="h-10 border-b border-white/10 bg-white/5" />
        {[...Array(8)].map((_, i) => (
          <div key={i} className="h-14 border-b border-white/5 px-4 py-3 flex items-center gap-4">
            <div className="h-4 w-48 rounded bg-white/10" />
            <div className="h-3 w-24 rounded bg-white/5" />
            <div className="ml-auto h-5 w-14 rounded-full bg-white/10" />
          </div>
        ))}
      </div>
    </div>
  );
}
