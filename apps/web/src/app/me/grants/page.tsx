import Link from 'next/link';
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

// Active grants within this window of expiry are surfaced as "expiring soon" so
// the holder can re-request before access lapses.
const EXPIRING_SOON_MS = 6 * 3_600_000;

function expiringSoon(expiresAt: Date | null): boolean {
  return expiresAt != null && expiresAt.getTime() - Date.now() < EXPIRING_SOON_MS;
}

const STATUS_STYLES = {
  active: 'bg-green-500/15 text-green-400',
  expired: 'bg-surface-2 text-text-3',
  pending: 'bg-yellow-500/15 text-yellow-400',
  revoked: 'bg-red-500/15 text-red-400',
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
      <div className="flex items-start justify-between">
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
        <Link
          href="/admin/access-grants/new"
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-bg hover:opacity-90 transition-opacity"
        >
          Request grant
        </Link>
      </div>

      {grants.length === 0 && (
        <div className="rounded-lg border border-border bg-surface p-8 text-center">
          <p className="text-sm text-text-2">No access grants yet.</p>
          <p className="mt-1 text-xs text-text-3">
            Request a grant above to gain time-boxed access to a specific user&apos;s sessions or a
            single session.
          </p>
        </div>
      )}

      {active.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-text-3">Active</h2>
          {active.map((g) => (
            <GrantCard key={g.id} grant={g} status="active" />
          ))}
        </section>
      )}

      {pending.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-text-3">
            Pending approval
          </h2>
          {pending.map((g) => (
            <GrantCard key={g.id} grant={g} status="pending" />
          ))}
        </section>
      )}

      {past.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-text-3">Past</h2>
          {past.map((g) => (
            <GrantCard key={g.id} grant={g} status={grantStatus(g)} />
          ))}
        </section>
      )}
    </div>
  );
}

function GrantCard({
  grant: g,
  status,
}: {
  grant: Grant;
  status: 'active' | 'expired' | 'pending' | 'revoked';
}) {
  const sessionLink =
    status === 'active' && g.scope === 'SINGLE_SESSION' && g.targetSessionId
      ? `/org/sessions/${g.targetSessionId}`
      : null;

  return (
    <div className="rounded-lg border border-border bg-surface p-4 space-y-2 text-sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs">
          <span className={`rounded px-1.5 py-0.5 font-medium ${STATUS_STYLES[status]}`}>
            {status}
          </span>
          <span className="text-text-3">· scope: {g.scope}</span>
          <span className="text-text-3">
            · requested {new Date(g.requestedAt).toLocaleDateString()}
          </span>
        </div>
        {sessionLink && (
          <Link
            href={sessionLink}
            className="text-xs text-accent hover:opacity-80 transition-opacity"
          >
            View session →
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
          Approved {new Date(g.grantedAt).toLocaleString()}
          {g.expiresAt && ` · expires ${new Date(g.expiresAt).toLocaleString()}`}
          {status === 'active' && expiringSoon(g.expiresAt) && (
            <span className="ml-2 rounded bg-yellow-500/15 px-1.5 py-0.5 text-yellow-400">
              expiring soon
            </span>
          )}
        </div>
      )}
      {g.revokedAt && (
        <div className="text-xs text-red-400/70">
          Revoked {new Date(g.revokedAt).toLocaleString()}
        </div>
      )}
    </div>
  );
}
