import type { ReactNode } from 'react';
import { ModelsTab, SkillsTab, ToolsTab } from '@/components/me/SessionTabs';
import { Timeline } from '@/components/me/Timeline';
import { cx } from '@/components/ui/cx';
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
  timelineExtra,
  toolRows,
}: {
  events: SessionEvent[];
  modelBreakdown: ModelBreakdownRow[];
  session: SessionDetail;
  skillRows: SessionSkillRow[];
  subagentRows: SessionSubagentRow[];
  tab: string;
  /**
   * Timeline-only content rendered inside the Timeline panel, below the tab
   * bar — so switching tabs never moves the bar itself.
   */
  timelineExtra?: ReactNode;
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
              aria-current={tab === t.id ? 'page' : undefined}
              className={cx(
                'pb-3 border-b-2 transition-colors',
                tab === t.id
                  ? 'border-accent text-text'
                  : 'border-transparent text-text-2 hover:text-text',
              )}
            >
              {t.label}
            </a>
          ))}
        </nav>
      </div>

      {tab === 'timeline' && (
        <div className="space-y-6">
          {timelineExtra}
          <Timeline events={events} session={session} />
        </div>
      )}
      {tab === 'tools' && <ToolsTab subagents={subagentRows} tools={toolRows} />}
      {tab === 'skills' && <SkillsTab rows={skillRows} />}
      {tab === 'models' && <ModelsTab costUsd={session.costUsd} rows={modelBreakdown} />}
    </>
  );
}
