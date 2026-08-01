// See app/me/prs/loading.tsx — skeletons carry a border so they read as cards
// on the near-white light-mode canvas, where `bg-surface` alone would vanish.
export default function MeLoading() {
  return (
    <div className="animate-pulse space-y-6">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="h-24 rounded-lg border border-border bg-surface" />
        ))}
      </div>
      <div className="h-48 rounded-lg border border-border bg-surface" />
      <div className="h-64 rounded-lg border border-border bg-surface" />
    </div>
  );
}
