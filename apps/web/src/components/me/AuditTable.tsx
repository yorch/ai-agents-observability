import Link from 'next/link';
import { Card, Cell, EmptyState, Pagination, Row, Table } from '@/components/ui';
import { fmtDateTime } from '@/lib/fmt';
import type { AuditRow } from '@/lib/me-queries';

type AuditTableProps = {
  currentPage: number;
  /** Builds the pager href for a page, preserving any active filters. */
  hrefFor?: (page: number) => string;
  rows: AuditRow[];
  total: number;
};

const PAGE_SIZE = 25;

// Keys are the stored AuditAction enum values (uppercase — a lowercase copy
// here once meant every row fell through to the raw enum text).
const ACTION_LABELS: Record<string, string> = {
  ADMIN_IMPERSONATE: 'admin impersonation',
  DELETE_REQUEST: 'data deletion request',
  EXPORT_ORG: 'org export',
  EXPORT_TEAM: 'team export',
  GRANT_APPROVED: 'share approved',
  GRANT_REVOKED: 'share revoked',
  HOOK_TOKEN_ISSUED: 'CLI token issued',
  VIEW_SESSION: 'viewed session',
  VIEW_TRANSCRIPT: 'viewed transcript',
};

export function AuditTable({
  rows,
  total,
  currentPage,
  hrefFor = (page) => `?page=${page}`,
}: AuditTableProps) {
  if (rows.length === 0) {
    return <EmptyState>No one has accessed your data yet.</EmptyState>;
  }

  return (
    <div className="space-y-4">
      <Card>
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
              <Cell className="text-text-2 whitespace-nowrap">{fmtDateTime(row.ts)} UTC</Cell>
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
      </Card>

      <Pagination page={currentPage} pageSize={PAGE_SIZE} total={total} hrefFor={hrefFor} />
    </div>
  );
}
