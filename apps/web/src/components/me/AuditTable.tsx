import Link from 'next/link';
import type { AuditRow } from '@/lib/me-queries';

type AuditTableProps = {
  currentPage: number;
  rows: AuditRow[];
  total: number;
};

const PAGE_SIZE = 25;

const ACTION_LABELS: Record<string, string> = {
  admin_impersonate: 'admin impersonation',
  delete_request: 'data deletion request',
  export_org: 'org export',
  export_team: 'team export',
  hook_token_issued: 'CLI token issued',
  view_session: 'viewed session',
  view_transcript: 'viewed transcript',
};

export function AuditTable({ rows, total, currentPage }: AuditTableProps) {
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const hasPrev = currentPage > 1;
  const hasNext = currentPage < totalPages;

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-white/10 bg-white/5 p-8 text-center">
        <p className="text-sm text-white/50">No one has accessed your data yet.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto rounded-lg border border-white/10">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10 text-white/40 text-xs">
              <th className="text-left px-4 py-3">Timestamp</th>
              <th className="text-left px-4 py-3">Actor</th>
              <th className="text-left px-4 py-3">Action</th>
              <th className="text-left px-4 py-3">Target</th>
              <th className="text-left px-4 py-3">Justification</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id.toString()} className="border-b border-white/5 hover:bg-white/5">
                <td className="px-4 py-3 text-white/60 whitespace-nowrap">
                  {row.ts.toLocaleString()}
                </td>
                <td className="px-4 py-3 text-white/70">@{row.actorLogin}</td>
                <td className="px-4 py-3">
                  <span className="rounded-full bg-white/10 px-2 py-0.5 text-xs text-white/70">
                    {ACTION_LABELS[row.action] ?? row.action}
                  </span>
                </td>
                <td className="px-4 py-3 text-white/60 text-xs">
                  {row.targetSessionId ? (
                    <Link
                      href={`/me/sessions/${row.targetSessionId}`}
                      className="font-mono hover:text-white underline"
                    >
                      session:{row.targetSessionId.slice(0, 8)}…
                    </Link>
                  ) : row.targetUserId ? (
                    <span className="font-mono">user:{row.targetUserId.slice(0, 8)}…</span>
                  ) : row.targetTeamId ? (
                    <span className="font-mono">team:{row.targetTeamId.slice(0, 8)}…</span>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="px-4 py-3 text-white/50 text-xs">{row.justification ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <p className="text-white/40">
            {(currentPage - 1) * PAGE_SIZE + 1}–{Math.min(currentPage * PAGE_SIZE, total)} of{' '}
            {total}
          </p>
          <div className="flex gap-2">
            {hasPrev && (
              <a
                href={`?page=${currentPage - 1}`}
                className="rounded-md border border-white/10 px-3 py-1.5 hover:bg-white/10 transition-colors"
              >
                ← Prev
              </a>
            )}
            {hasNext && (
              <a
                href={`?page=${currentPage + 1}`}
                className="rounded-md border border-white/10 px-3 py-1.5 hover:bg-white/10 transition-colors"
              >
                Next →
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
