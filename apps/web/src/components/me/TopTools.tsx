type ToolEntry = { callCount: number; toolName: string };

export function TopTools({ title = 'Top Tools', tools }: { title?: string; tools: ToolEntry[] }) {
  if (tools.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface p-4">
        <h2 className="text-xs text-text-3 uppercase tracking-widest mb-4">{title}</h2>
        <p className="text-sm text-text-3">No data</p>
      </div>
    );
  }

  const max = Math.max(...tools.map((t) => t.callCount), 1);

  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <h2 className="text-xs text-text-3 uppercase tracking-widest mb-4">{title}</h2>
      <div className="space-y-3">
        {tools.map((tool) => (
          <div key={tool.toolName}>
            <div className="flex justify-between text-xs mb-1">
              <span className="truncate text-text-2 font-mono">{tool.toolName}</span>
              <span className="text-text-3 font-mono ml-2 shrink-0">{tool.callCount}</span>
            </div>
            <div className="h-1.5 w-full rounded-full bg-surface-2 overflow-hidden">
              <div
                className="h-full rounded-full bg-accent"
                style={{ width: `${(tool.callCount / max) * 100}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
