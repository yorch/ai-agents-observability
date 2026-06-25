import { ModelsTab, ToolsTab } from '@/components/me/SessionTabs';
import { Timeline } from '@/components/me/Timeline';
import type { ModelBreakdownRow, SessionDetail, SessionEvent } from '@/lib/sessions-queries';

const TABS = [
  { href: '?tab=timeline', id: 'timeline', label: 'Timeline' },
  { href: '?tab=tools', id: 'tools', label: 'Tools' },
  { href: '?tab=models', id: 'models', label: 'Models' },
] as const;

export function SessionDetailTabs({
  events,
  modelBreakdown,
  session,
  tab,
}: {
  events: SessionEvent[];
  modelBreakdown: ModelBreakdownRow[];
  session: SessionDetail;
  tab: string;
}) {
  return (
    <>
      <div className="border-b border-border">
        <nav className="flex gap-6 text-sm">
          {TABS.map((t) => (
            <a
              key={t.id}
              href={t.href}
              className={`pb-3 border-b-2 transition-colors ${
                tab === t.id
                  ? 'border-accent text-text'
                  : 'border-transparent text-text-2 hover:text-text'
              }`}
            >
              {t.label}
            </a>
          ))}
        </nav>
      </div>

      {tab === 'timeline' && <Timeline events={events} session={session} />}
      {tab === 'tools' && <ToolsTab session={session} />}
      {tab === 'models' && <ModelsTab costUsd={session.costUsd} rows={modelBreakdown} />}
    </>
  );
}
