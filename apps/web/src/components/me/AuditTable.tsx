import Link from 'next/link';
import { Card, Cell, EmptyState, Pagination, Row, Table } from '@/components/ui';
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
      </Card>

      <Pagination
        page={currentPage}
        pageSize={PAGE_SIZE}
        total={total}
        hrefFor={(n) => `?page=${n}`}
      />
    </div>
  );
}
