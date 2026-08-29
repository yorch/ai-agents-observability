import Link from 'next/link';
import { ArrowRightIcon } from '@/components/icons';
import { buttonClasses, Card, EmptyState } from '@/components/ui';
import { format } from '@/i18n/config';
import type { Dictionary } from '@/i18n/dictionary';
import { getTranslations } from '@/i18n/server';
import { fmtDate, fmtDateTime } from '@/lib/fmt';
import { isGrantExpiringSoon } from '@/lib/grant-policy';
import { getPrisma } from '@/lib/prisma';
import { requireGrantRequester } from '@/lib/roles';

export const dynamic = 'force-dynamic';

function grantStatus(g: {
  expiresAt: Date | null;
  grantedAt: Date | null;
  revokedAt: Date | null;
}): 'active' | 'expired' | 'pending' | 'revoked' {
  if (g.revokedAt) {
    return 'revoked';
  }
  if (!g.grantedAt) {
    return 'pending';
  }
  if (g.expiresAt && g.expiresAt <= new Date()) {
    return 'expired';
  }
  return 'active';
}

const STATUS_STYLES = {
  active: 'bg-good-soft text-good',
  expired: 'bg-surface-2 text-text-3',
  pending: 'bg-warn-soft text-warn',
  revoked: 'bg-crit-soft text-crit',
};

type Grant = {
  expiresAt: Date | null;
  grantedAt: Date | null;
  grantedByUserId: string | null;
  id: string;
  justification: string;
  requestedAt: Date;
  revokedAt: Date | null;
  scope: string;
  targetSessionId: string | null;
  targetUserId: string | null;
};

export default async function GrantsPage() {
  const { orgRole, user } = await requireGrantRequester();
  const { dict } = await getTranslations();
  const isAdmin = orgRole === 'ORG_ADMIN';

  const rawGrants = await getPrisma().accessGrant.findMany({
    orderBy: { requestedAt: 'desc' },
    take: 100,
    where: { granteeUserId: user.id },
  });

  const grants: Grant[] = rawGrants.map((g: Grant & { scope: unknown }) => ({
    expiresAt: g.expiresAt,
    grantedAt: g.grantedAt,
    grantedByUserId: g.grantedByUserId,
    id: g.id,
    justification: g.justification,
    requestedAt: g.requestedAt,
    revokedAt: g.revokedAt,
    scope: g.scope as string,
    targetSessionId: g.targetSessionId,
    targetUserId: g.targetUserId,
  }));

  const active = grants.filter((g) => grantStatus(g) === 'active');
  const pending = grants.filter((g) => grantStatus(g) === 'pending');
  const past = grants.filter((g) => {
    const s = grantStatus(g);
    return s === 'expired' || s === 'revoked';
  });

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="font-display text-xl font-semibold tracking-tight text-text">
            My access grants
          </h1>
          <p className="text-sm text-text-2">
            Time-boxed grants give you access to another user&apos;s sessions and transcripts.
            {isAdmin
              ? ' As org admin you also have standing access to all individual sessions.'
              : ' Each grant must be approved by an org admin before it becomes active.'}
          </p>
        </div>
        <Link href="/admin/access-grants/new" className={buttonClasses('primary', 'sm')}>
          Request grant
        </Link>
      </div>

      {grants.length === 0 && (
        <EmptyState title={dict.me.grants.empty}>
          Request a grant above to gain time-boxed access to a specific user&apos;s sessions or a
          single session.
        </EmptyState>
      )}

      {active.length > 0 && (
        <section className="space-y-3">
          <h2 className="font-mono text-[10px] uppercase tracking-widest text-text-3">
            {dict.me.grants.active}
          </h2>
          {active.map((g) => (
            <GrantCard key={g.id} grant={g} status="active" dict={dict} />
          ))}
        </section>
      )}

      {pending.length > 0 && (
        <section className="space-y-3">
          <h2 className="font-mono text-[10px] uppercase tracking-widest text-text-3">
            Pending approval
          </h2>
          {pending.map((g) => (
            <GrantCard key={g.id} grant={g} status="pending" dict={dict} />
          ))}
        </section>
      )}

      {past.length > 0 && (
        <section className="space-y-3">
          <h2 className="font-mono text-[10px] uppercase tracking-widest text-text-3">
            {dict.me.grants.past}
          </h2>
          {past.map((g) => (
            <GrantCard key={g.id} grant={g} status={grantStatus(g)} dict={dict} />
          ))}
        </section>
      )}
    </div>
  );
}

function GrantCard({
  grant: g,
  status,
  dict,
}: {
  grant: Grant;
  status: 'active' | 'expired' | 'pending' | 'revoked';
  dict: Dictionary;
}) {
  const sessionLink =
    status === 'active' && g.scope === 'SINGLE_SESSION' && g.targetSessionId
      ? `/org/sessions/${g.targetSessionId}`
      : null;

  return (
    <Card className="text-sm" contentClassName="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs">
          <span className={`rounded px-1.5 py-0.5 font-medium ${STATUS_STYLES[status]}`}>
            {status}
          </span>
          <span className="text-text-3">· scope: {g.scope}</span>
          <span className="text-text-3">· requested {fmtDate(new Date(g.requestedAt))}</span>
        </div>
        {sessionLink && (
          <Link
            href={sessionLink}
            className="inline-flex items-center gap-1 text-xs text-accent hover:opacity-80 transition-opacity"
          >
            View session <ArrowRightIcon />
          </Link>
        )}
      </div>

      <p className="text-text-2">{g.justification}</p>

      <div className="text-xs text-text-3 font-mono">
        {g.scope === 'SINGLE_SESSION'
          ? g.targetSessionId
            ? `session ${g.targetSessionId}`
            : 'no session specified'
          : g.targetUserId
            ? `all sessions for user ${g.targetUserId}`
            : 'all sessions for unspecified user'}
      </div>

      {g.grantedAt && (
        <div className="text-xs text-text-3">
          Approved {fmtDateTime(new Date(g.grantedAt))} UTC
          {g.expiresAt && ` · expires ${fmtDateTime(new Date(g.expiresAt))} UTC`}
          {status === 'active' && isGrantExpiringSoon(g.expiresAt) && (
            <span className="ml-2 rounded bg-warn-soft px-1.5 py-0.5 text-warn">
              {dict.me.grants.expiringSoon}
            </span>
          )}
        </div>
      )}
      {g.revokedAt && (
        <div className="text-xs text-crit">
          {format(dict.me.grants.revoked, { date: fmtDateTime(new Date(g.revokedAt)) })}
        </div>
      )}
    </Card>
  );
}
