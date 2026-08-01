import { Card, HBars } from '@/components/ui';

type ToolEntry = { callCount: number; toolName: string };

export function TopTools({ title = 'Top tools', tools }: { title?: string; tools: ToolEntry[] }) {
  return (
    <Card title={title}>
      <HBars
        // One measure across one dimension — magnitude, not identity — so the
        // bars take the accent rather than six competing series hues.
        tinted={false}
        rows={tools.map((tool) => ({
          display: tool.callCount.toLocaleString(),
          label: tool.toolName,
          value: tool.callCount,
        }))}
      />
    </Card>
  );
}
