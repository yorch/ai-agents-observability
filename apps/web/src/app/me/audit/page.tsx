import { redirect } from 'next/navigation';
import { AuditTable } from '@/components/me/AuditTable';
import { currentUser } from '@/lib/auth';
import { getAuditLog } from '@/lib/me-queries';
import { daysAgo } from '@/lib/time';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 25;

const VALID_ACTIONS = new Set(['view_session', 'view_transcript', 'export_team']);

const DATE_OPTIONS = [
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
  { days: null, label: 'All time' },
] as const;

const ACTION_LABELS: Record<string, string> = {
  export_team: 'Team export',
  view_session: 'Viewed session',
  view_transcript: 'Viewed transcript',
};

type SearchParams = { action?: string; days?: string; page?: string };

export default async function AuditPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const user = await currentUser();
  if (!user) {
    redirect('/login');
  }

  const params = await searchParams;
  const page = Math.max(1, parseInt(params.page ?? '1', 10));
  const actionFilter =
    params.action && VALID_ACTIONS.has(params.action) ? params.action : undefined;
  const daysFilter = params.days ? parseInt(params.days, 10) : undefined;
  const since = daysFilter && daysFilter > 0 ? daysAgo(daysFilter) : undefined;

  const { rows, total } = await getAuditLog(
    user.id,
    {
      ...(actionFilter ? { action: actionFilter } : {}),
      ...(since ? { since } : {}),
    },
    page,
    PAGE_SIZE,
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Audit log</h1>
        <p className="mt-1 text-sm text-white/50">
          Records of when your data was accessed by team or org members.
        </p>
      </div>

      {/* Filters */}
      <form method="GET" className="flex flex-wrap gap-3">
        <select
          name="action"
          defaultValue={actionFilter ?? ''}
          className="rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-white/70 focus:outline-none focus:ring-1 focus:ring-brand-500"
        >
          <option value="">All actions</option>
          {Object.entries(ACTION_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <select
          name="days"
          defaultValue={daysFilter?.toString() ?? ''}
          className="rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-white/70 focus:outline-none focus:ring-1 focus:ring-brand-500"
        >
          {DATE_OPTIONS.map((o) => (
            <option key={o.label} value={o.days ?? ''}>
              {o.label}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="rounded-md border border-white/10 px-3 py-1.5 text-sm hover:bg-white/10 transition-colors"
        >
          Filter
        </button>
        {(actionFilter || daysFilter) && (
          <a
            href="/me/audit"
            className="rounded-md border border-white/10 px-3 py-1.5 text-sm hover:bg-white/10 transition-colors text-white/50"
          >
            Clear
          </a>
        )}
      </form>

      <AuditTable rows={rows} total={total} currentPage={page} />
    </div>
  );
}
