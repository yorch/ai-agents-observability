type ToolEntry = { callCount: number; toolName: string };

export function TopTools({
  title = 'Top Models by Tool Calls',
  tools,
}: {
  title?: string;
  tools: ToolEntry[];
}) {
  if (tools.length === 0) {
    return (
      <div className="rounded-lg border border-white/10 bg-white/5 p-4">
        <h2 className="text-sm font-medium text-white/70 mb-4">{title}</h2>
        <p className="text-sm text-white/40">No data</p>
      </div>
    );
  }

  const max = Math.max(...tools.map((t) => t.callCount), 1);

  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-4">
      <h2 className="text-sm font-medium text-white/70 mb-4">{title}</h2>
      <div className="space-y-3">
        {tools.map((tool) => (
          <div key={tool.toolName}>
            <div className="flex justify-between text-xs mb-1">
              <span className="truncate text-white/80">{tool.toolName}</span>
              <span className="text-white/50 ml-2 shrink-0">{tool.callCount}</span>
            </div>
            <div className="h-2 w-full rounded-full bg-white/10 overflow-hidden">
              <div
                className="h-full rounded-full bg-brand-500"
                style={{ width: `${(tool.callCount / max) * 100}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
