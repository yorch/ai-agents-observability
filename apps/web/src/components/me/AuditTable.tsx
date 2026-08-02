import Link from 'next/link';
import { ArrowLeftIcon, ArrowRightIcon } from '@/components/icons';
import { Cell, EmptyState, Row, Table } from '@/components/ui';
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
    return <EmptyState>No one has accessed your data yet.</EmptyState>;
  }

  return (
    <div className="space-y-4">
      <Table
        columns={[
          { label: 'Timestamp' },
          { label: 'Actor' },
          { label: 'Action' },
          { label: 'Target' },
          { label: 'Justification' },
        ]}
      >
        {rows.map((row) => (
          <Row key={row.id.toString()}>
            <Cell className="text-text-2 whitespace-nowrap">{row.ts.toLocaleString()}</Cell>
            <Cell className="text-text-2">{row.actorLogin ? `@${row.actorLogin}` : '—'}</Cell>
            <Cell>
              <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-text-2">
                {ACTION_LABELS[row.action] ?? row.action}
              </span>
            </Cell>
            <Cell className="text-text-2 text-xs">
              {row.targetSessionId ? (
                <Link
                  href={`/me/sessions/${row.targetSessionId}`}
                  className="font-mono hover:text-text underline"
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
            </Cell>
            <Cell className="text-text-2 text-xs">{row.justification ?? '—'}</Cell>
          </Row>
        ))}
      </Table>

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <p className="text-text-3">
            {(currentPage - 1) * PAGE_SIZE + 1}–{Math.min(currentPage * PAGE_SIZE, total)} of{' '}
            {total}
          </p>
          <div className="flex gap-2">
            {hasPrev && (
              <a
                href={`?page=${currentPage - 1}`}
                className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 hover:bg-surface-2 transition-colors"
              >
                <ArrowLeftIcon /> Prev
              </a>
            )}
            {hasNext && (
              <a
                href={`?page=${currentPage + 1}`}
                className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 hover:bg-surface-2 transition-colors"
              >
                Next <ArrowRightIcon />
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
