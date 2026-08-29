import { AuditAction } from '@ai-agents-observability/db';
import { CheckIcon } from '@/components/icons';
import { OversightPanel } from '@/components/me/OversightPanel';
import { DateRangePicker } from '@/components/team-org/DateRangePicker';
import { Cell, EmptyState, Row, Stat, Table } from '@/components/ui';
import { format } from '@/i18n/config';
import { getTranslations } from '@/i18n/server';
import { getOrgOversight } from '@/lib/oversight-queries';
import { getAgentPrProvenance } from '@/lib/pr-provenance-queries';
import { getPrisma } from '@/lib/prisma';
import { requireOrgViewer } from '@/lib/roles';
import { daysAgo } from '@/lib/time';

export const dynamic = 'force-dynamic';

/**
 * Governance & oversight-posture report (R12). Aggregate, visibility-scoped
 * evidence of how much autonomy the org grants its coding agents and how
 * privileged access is governed — the kind of record EU AI Act Art. 14 / NIST
 * RMF / SOC 2 human-oversight expectations ask for. No individual is named.
 */
export default async function GovernancePage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  await requireOrgViewer();
  const { dict } = await getTranslations();
  const { range: rangeParam } = await searchParams;
  // Shared ?range convention + DateRangePicker, consistent with team/org dashboards.
  const range = ([7, 30, 90].includes(Number(rangeParam)) ? Number(rangeParam) : 30) as 7 | 30 | 90;
  const now = new Date();
  const since = daysAgo(range);

  const db = getPrisma();
  const [oversight, transcriptViews, grantsApproved, activeGrants, pendingGrants, provenance] =
    await Promise.all([
      getOrgOversight(since),
      db.auditLog.count({ where: { action: AuditAction.VIEW_TRANSCRIPT, ts: { gte: since } } }),
      db.auditLog.count({ where: { action: AuditAction.GRANT_APPROVED, ts: { gte: since } } }),
      db.accessGrant.count({
        where: { expiresAt: { gt: now }, grantedAt: { not: null }, revokedAt: null },
      }),
      db.accessGrant.count({ where: { grantedAt: null, revokedAt: null } }),
      getAgentPrProvenance(since),
    ]);

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="font-display text-xl font-semibold tracking-tight text-text">
            {dict.org.governance.title}
          </h1>
          <p className="max-w-2xl text-sm text-text-2">{dict.org.governance.description}</p>
        </div>
        <DateRangePicker range={range} />
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-text">{dict.org.governance.autonomyPosture}</h2>
        {oversight.totalSessions === 0 ? (
          <EmptyState>{dict.org.governance.emptySessions}</EmptyState>
        ) : (
          <OversightPanel data={oversight} />
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-text">{dict.org.governance.privilegedAccess}</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat
            label={dict.org.governance.activeGrants}
            value={activeGrants.toLocaleString()}
            sub={dict.org.governance.activeGrantsSub}
          />
          <Stat
            label={dict.org.governance.pendingGrants}
            value={pendingGrants.toLocaleString()}
            sub={dict.org.governance.awaiting}
            accent={pendingGrants > 0 ? 'warn' : undefined}
          />
          <Stat
            label={dict.org.governance.grantsApproved}
            value={grantsApproved.toLocaleString()}
            sub={format(dict.org.governance.grantsApprovedSub, { range })}
          />
          <Stat
            label={dict.org.governance.transcriptViews}
            value={transcriptViews.toLocaleString()}
            sub={format(dict.org.governance.transcriptViewsSub, { range })}
          />
        </div>
        <p className="text-xs text-text-3">{dict.org.governance.privilegedAccessNote}</p>
      </section>

      {/* R10: provenance + human review of AI-authored code. */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-text">{dict.org.governance.aiReview}</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat
            label={dict.org.governance.agentAssistedPrs}
            value={provenance.total.toLocaleString()}
          />
          <Stat
            label={dict.org.governance.awaitingReview}
            value={provenance.awaitingReview.toLocaleString()}
            sub={dict.org.governance.awaitingReviewSub}
            accent={provenance.awaitingReview > 0 ? 'warn' : undefined}
          />
          <Stat
            label={dict.org.governance.mergedWithoutReview}
            value={provenance.mergedWithoutIndependentReview.toLocaleString()}
            sub={dict.org.governance.mergedWithoutReviewSub}
            accent={provenance.mergedWithoutIndependentReview > 0 ? 'crit' : 'good'}
          />
          <Stat
            label={dict.org.governance.window}
            value={`${range}d`}
            sub={format(dict.org.governance.windowSub, {
              shown: Math.min(provenance.rows.length, 30),
              total: provenance.total,
            })}
          />
        </div>
        {provenance.rows.length === 0 ? (
          <EmptyState>{dict.org.governance.emptyPrs}</EmptyState>
        ) : (
          <Table
            columns={[
              { label: 'PR' },
              { label: 'Author' },
              { label: 'State' },
              { label: dict.org.governance.independentReview },
              { label: 'Sessions' },
            ]}
          >
            {provenance.rows.slice(0, 30).map((r) => (
              <Row key={`${r.repoOwner}/${r.repoName}#${r.prNumber}`}>
                <Cell>
                  <span className="text-text-3">
                    {r.repoOwner}/{r.repoName}
                  </span>{' '}
                  #{r.prNumber}
                  {r.reverted && <span className="ml-1 text-crit">(reverted)</span>}
                </Cell>
                <Cell className="text-text-2">{r.authorLogin}</Cell>
                <Cell className="text-text-2">{r.state}</Cell>
                <Cell>
                  {r.reviewedByOther ? (
                    <span className="inline-flex items-center gap-1 text-good">
                      <CheckIcon size={12} /> {dict.org.governance.yes}
                    </span>
                  ) : r.awaitingReview ? (
                    <span className="text-warn">{dict.org.governance.awaiting}</span>
                  ) : (
                    <span className="text-crit">{dict.org.governance.no}</span>
                  )}
                </Cell>
                <Cell className="text-text-2">{r.sessionCount}</Cell>
              </Row>
            ))}
          </Table>
        )}
        <p className="text-xs text-text-3">{dict.org.governance.independentReviewNote}</p>
      </section>
    </div>
  );
}
