import { Card, HBars } from '@/components/ui';

type ToolEntry = { callCount: number; toolName: string };

export function TopTools({ title = 'Top tools', tools }: { title?: string; tools: ToolEntry[] }) {
  return (
    <Card title={title}>
      <HBars
        rows={tools.map((tool) => ({
          display: tool.callCount.toLocaleString(),
          label: tool.toolName,
          value: tool.callCount,
        }))}
      />
    </Card>
  );
}
