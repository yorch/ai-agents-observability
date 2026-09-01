import { redirect } from 'next/navigation';
import { AuditTable } from '@/components/me/AuditTable';
import { Button, ButtonLink, Field, Select } from '@/components/ui';
import { currentUser } from '@/lib/auth';
import { getAuditLog } from '@/lib/me-queries';
import { daysAgo } from '@/lib/time';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 25;

const DATE_OPTIONS = [
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
  { days: null, label: 'All time' },
] as const;

// Keys are the stored AuditAction enum values (uppercase). The option values
// and the whitelist both derive from this map so they cannot disagree — a
// lowercase copy here once made the filter silently never apply.
const ACTION_LABELS: Record<string, string> = {
  EXPORT_TEAM: 'Team export',
  // P13-009: the judge is a privileged reader like any other, and the subject
  // can filter its reads out of the feed the same way.
  JUDGE_READ_TRANSCRIPT: 'Automated evaluation',
  VIEW_SESSION: 'Viewed session',
  VIEW_TRANSCRIPT: 'Viewed transcript',
};

const VALID_ACTIONS = new Set(Object.keys(ACTION_LABELS));

type SearchParams = { action?: string; days?: string; page?: string };

export default async function SettingsAuditPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await currentUser();
  if (!user) {
    redirect('/login');
  }

  const params = await searchParams;
  const page = Math.max(1, Number(params.page ?? '1') || 1);
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
        <h2 className="font-display text-lg font-semibold text-text">Audit log</h2>
        <p className="mt-0.5 text-sm text-text-2">
          Records of when your data was accessed by team or org members.
        </p>
      </div>

      <form method="GET" className="flex flex-wrap items-end gap-3">
        <Field label="Action" htmlFor="action-filter">
          <Select id="action-filter" name="action" defaultValue={actionFilter ?? ''}>
            <option value="">All actions</option>
            {Object.entries(ACTION_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Period" htmlFor="days-filter">
          <Select id="days-filter" name="days" defaultValue={daysFilter?.toString() ?? ''}>
            {DATE_OPTIONS.map((o) => (
              <option key={o.label} value={o.days ?? ''}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
        <Button variant="secondary" type="submit">
          Filter
        </Button>
        {(actionFilter || daysFilter) && (
          <ButtonLink variant="secondary" href="/me/settings/audit">
            Clear
          </ButtonLink>
        )}
      </form>

      <AuditTable
        rows={rows}
        total={total}
        currentPage={page}
        hrefFor={(n) => {
          const p = new URLSearchParams();
          if (actionFilter) {
            p.set('action', actionFilter);
          }
          if (params.days) {
            p.set('days', params.days);
          }
          p.set('page', String(n));
          return `?${p.toString()}`;
        }}
      />
    </div>
  );
}
