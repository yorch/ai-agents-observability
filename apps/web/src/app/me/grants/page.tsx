import Link from 'next/link';
import { OrgRole } from '@ai-agents-observability/db';
import { getPrisma } from '@/lib/prisma';
import { requireGrantRequester } from '@/lib/roles';

export const dynamic = 'force-dynamic';

function grantStatus(g: {
  expiresAt: Date | null;
  grantedAt: Date | null;
  revokedAt: Date | null;
}): 'active' | 'expired' | 'pending' | 'revoked' {
  if (g.revokedAt) return 'revoked';
  if (!g.grantedAt) return 'pending';
  if (g.expiresAt && g.expiresAt <= new Date()) return 'expired';
  return 'active';
}

const STATUS_STYLES = {
  active: 'bg-green-500/20 text-green-300',
  expired: 'bg-white/10 text-white/30',
  pending: 'bg-yellow-500/20 text-yellow-300',
  revoked: 'bg-red-500/20 text-red-300',
};

export default async function GrantsPage() {
  const { orgRole, user } = await requireGrantRequester();
  const isAdmin = orgRole === OrgRole.ORG_ADMIN;

  const grants = await getPrisma().accessGrant.findMany({
    orderBy: { requestedAt: 'desc' },
    take: 100,
    where: { granteeUserId: user.id },
  });

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
          <h1 className="text-xl font-semibold">My access grants</h1>
          <p className="text-sm text-white/50">
            Time-boxed grants give you access to another user's sessions and transcripts.
            {isAdmin
              ? ' As org admin you also have standing access to all individual sessions.'
              : ' Each grant must be approved by an org admin before it becomes active.'}
          </p>
        </div>
        <Link
          href="/admin/access-grants/new"
          className="rounded-md bg-brand-500 px-3 py-1.5 text-sm font-medium hover:bg-brand-600 transition-colors"
        >
          Request grant
        </Link>
      </div>

      {grants.length === 0 && (
        <div className="rounded-lg border border-white/10 p-8 text-center">
          <p className="text-sm text-white/50">No access grants yet.</p>
          <p className="mt-1 text-xs text-white/30">
            Request a grant above to gain time-boxed access to a specific user's sessions or a single session.
          </p>
        </div>
      )}

      {active.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-white/70">Active</h2>
          {active.map((g) => (
            <GrantCard key={g.id} grant={g} status="active" />
          ))}
        </section>
      )}

      {pending.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-white/70">Pending approval</h2>
          {pending.map((g) => (
            <GrantCard key={g.id} grant={g} status="pending" />
          ))}
        </section>
      )}

      {past.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-white/70">Past</h2>
          {past.map((g) => (
            <GrantCard key={g.id} grant={g} status={grantStatus(g)} />
          ))}
        </section>
      )}
    </div>
  );
}

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
    <div className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-2 text-sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs">
          <span className={`rounded px-1.5 py-0.5 font-medium ${STATUS_STYLES[status]}`}>{status}</span>
          <span className="text-white/40">· scope: {g.scope}</span>
          <span className="text-white/30">· requested {new Date(g.requestedAt).toLocaleDateString()}</span>
        </div>
        {sessionLink && (
          <Link
            href={sessionLink}
            className="text-xs text-brand-400 hover:text-brand-300 hover:underline"
          >
            View session →
          </Link>
        )}
      </div>

      <p className="text-white/70">{g.justification}</p>

      <div className="text-xs text-white/30 font-mono">
        {g.scope === 'SINGLE_SESSION'
          ? g.targetSessionId
            ? `session ${g.targetSessionId}`
            : 'no session specified'
          : g.targetUserId
            ? `all sessions for user ${g.targetUserId}`
            : 'all sessions for unspecified user'}
      </div>

      {g.grantedAt && (
        <div className="text-xs text-white/30">
          Approved {new Date(g.grantedAt).toLocaleString()}
          {g.expiresAt && ` · expires ${new Date(g.expiresAt).toLocaleString()}`}
        </div>
      )}
      {g.revokedAt && (
        <div className="text-xs text-red-300/60">Revoked {new Date(g.revokedAt).toLocaleString()}</div>
      )}
    </div>
  );
}
