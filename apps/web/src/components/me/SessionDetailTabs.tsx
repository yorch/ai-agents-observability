import { ModelsTab, ToolsTab } from '@/components/me/SessionTabs';
import { Timeline } from '@/components/me/Timeline';
import type { ModelBreakdownRow, SessionDetail, SessionEvent } from '@/lib/sessions-queries';

const TABS = [
  { href: '?tab=timeline', id: 'timeline', label: 'Timeline' },
  { href: '?tab=tools', id: 'tools', label: 'Tools' },
  { href: '?tab=models', id: 'models', label: 'Models' },
] as const;

/**
 * The session-detail tab bar plus the three tab bodies. Identical across the
 * /me, /team, and /org session-detail pages — those pages own the audience-
 * specific auth/audit/header and delegate the body to this component.
 *
 * `events` is only read by the Timeline tab and `modelBreakdown` only by the
 * Models tab, so callers may pass empty arrays for the inactive tabs.
 */
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
      <div className="border-b border-white/10">
        <nav className="flex gap-4 text-sm">
          {TABS.map((t) => (
            <a
              key={t.id}
              href={t.href}
              className={`pb-3 border-b-2 transition-colors ${
                tab === t.id
                  ? 'border-brand-500 text-white'
                  : 'border-transparent text-white/50 hover:text-white'
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
