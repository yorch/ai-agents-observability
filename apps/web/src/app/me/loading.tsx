export default function MeLoading() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="h-24 rounded-lg bg-white/5" />
        ))}
      </div>
      <div className="h-48 rounded-lg bg-white/5" />
      <div className="h-64 rounded-lg bg-white/5" />
    </div>
  );
}
