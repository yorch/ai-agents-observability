import { isGrantExpiringSoon } from '@/lib/grant-policy';
import { getPrisma } from '@/lib/prisma';
import { requireOrgAdmin } from '@/lib/roles';
import { approveAllPending, approveGrant, revokeGrant } from './actions';

export const dynamic = 'force-dynamic';

type Grant = {
  expiresAt: Date | null;
  grantedAt: Date | null;
  id: string;
  justification: string;
  revokedAt: Date | null;
  scope: string;
  targetSessionId: string | null;
  targetUserId: string | null;
};

function status(g: Grant): string {
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

function expiringSoon(g: Grant): boolean {
  return status(g) === 'active' && isGrantExpiringSoon(g.expiresAt);
}

function GrantCard({ g }: { g: Grant }) {
  const st = status(g);
  return (
    <div className="rounded-lg border border-border bg-surface p-4 space-y-2 text-sm">
      <div className="flex items-center gap-2 text-xs text-text-3">
        <span className="rounded bg-surface-2 px-1.5 py-0.5 text-text-2">{st}</span>
        <span>· scope: {g.scope}</span>
        {g.expiresAt && <span>· expires {new Date(g.expiresAt).toLocaleString()}</span>}
        {expiringSoon(g) && (
          <span className="rounded bg-warn-soft px-1.5 py-0.5 text-warn">expiring soon</span>
        )}
      </div>
      <p className="text-text-2">{g.justification}</p>
      <p className="text-xs text-text-3 font-mono">
        {g.scope === 'SINGLE_SESSION'
          ? `session ${g.targetSessionId?.slice(0, 8)}…`
          : `user ${g.targetUserId?.slice(0, 8)}…`}
      </p>
      <div className="flex gap-2 pt-1">
        {st === 'pending' && (
          <form action={approveGrant} className="inline-flex items-center gap-2">
            <input type="hidden" name="id" value={g.id} />
            <input
              type="number"
              name="hours"
              min={1}
              placeholder="48"
              aria-label="Grant lifetime (hours)"
              className="w-20 rounded-md border border-border bg-surface px-2 py-1 text-right text-xs"
            />
            <button
              type="submit"
              className="rounded-md bg-accent px-3 py-1 text-xs font-medium text-bg hover:opacity-90"
            >
              Approve (h)
            </button>
          </form>
        )}
        {st === 'active' && (
          <form action={revokeGrant}>
            <input type="hidden" name="id" value={g.id} />
            <button
              type="submit"
              className="rounded-md border border-crit-line px-3 py-1 text-xs text-crit hover:bg-crit-soft"
            >
              Revoke
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

export default async function AccessGrantsPage() {
  await requireOrgAdmin();

  const grants = await getPrisma().accessGrant.findMany({
    orderBy: { requestedAt: 'desc' },
    take: 100,
  });

  const pending = grants.filter((g) => status(g) === 'pending');
  const rest = grants.filter((g) => status(g) !== 'pending');

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h1 className="font-display text-xl font-semibold tracking-tight text-text">
            Access grants
          </h1>
          <p className="text-sm text-text-2">
            Time-boxed, audited transcript access (§8.4). Approve a request to grant access for a
            bounded window; revoke any time. The viewed user sees every grant in their audit feed.
          </p>
        </div>
        <a
          href="/admin/access-grants/new"
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-bg hover:opacity-90"
        >
          New request
        </a>
      </div>

      {/* Needs attention: pending requests awaiting approval (R8). */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium text-text">
            Needs attention
            <span className="ml-2 rounded-full bg-surface-2 px-2 py-0.5 text-xs text-text-2">
              {pending.length} pending
            </span>
          </h2>
          {pending.length > 0 && (
            <form action={approveAllPending} className="inline-flex items-center gap-2">
              <input
                type="number"
                name="hours"
                min={1}
                placeholder="48"
                aria-label="Bulk grant lifetime (hours)"
                className="w-20 rounded-md border border-border bg-surface px-2 py-1 text-right text-xs"
              />
              <button
                type="submit"
                className="rounded-md border border-accent/60 px-3 py-1 text-xs font-medium text-accent hover:bg-accent/10"
              >
                Approve all ({pending.length})
              </button>
            </form>
          )}
        </div>
        {pending.length === 0 ? (
          <p className="text-sm text-text-3">No requests awaiting approval.</p>
        ) : (
          <div className="space-y-3">
            {pending.map((g) => (
              <GrantCard key={g.id} g={g} />
            ))}
          </div>
        )}
      </section>

      {/* All other grants. */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-text">All grants</h2>
        {rest.length === 0 ? (
          <p className="text-sm text-text-3">No active or past grants.</p>
        ) : (
          <div className="space-y-3">
            {rest.map((g) => (
              <GrantCard key={g.id} g={g} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
