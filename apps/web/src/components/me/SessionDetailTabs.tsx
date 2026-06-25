import { ModelsTab, SkillsTab, ToolsTab } from '@/components/me/SessionTabs';
import { Timeline } from '@/components/me/Timeline';
import type {
  ModelBreakdownRow,
  SessionDetail,
  SessionEvent,
  SessionSkillRow,
  SessionSubagentRow,
  SessionToolRow,
} from '@/lib/sessions-queries';

const TABS = [
  { href: '?tab=timeline', id: 'timeline', label: 'Timeline' },
  { href: '?tab=tools', id: 'tools', label: 'Tools' },
  { href: '?tab=skills', id: 'skills', label: 'Skills' },
  { href: '?tab=models', id: 'models', label: 'Models' },
] as const;

export function SessionDetailTabs({
  events,
  modelBreakdown,
  session,
  skillRows,
  subagentRows,
  tab,
  toolRows,
}: {
  events: SessionEvent[];
  modelBreakdown: ModelBreakdownRow[];
  session: SessionDetail;
  skillRows: SessionSkillRow[];
  subagentRows: SessionSubagentRow[];
  tab: string;
  toolRows: SessionToolRow[];
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
      {tab === 'tools' && <ToolsTab subagents={subagentRows} tools={toolRows} />}
      {tab === 'skills' && <SkillsTab rows={skillRows} />}
      {tab === 'models' && <ModelsTab costUsd={session.costUsd} rows={modelBreakdown} />}
    </>
  );
}
