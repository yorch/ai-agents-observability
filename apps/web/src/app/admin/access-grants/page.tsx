import { getPrisma } from '@/lib/prisma';
import { requireOrgAdmin } from '@/lib/roles';
import { approveGrant, revokeGrant } from './actions';

export const dynamic = 'force-dynamic';

function status(g: {
  expiresAt: Date | null;
  grantedAt: Date | null;
  revokedAt: Date | null;
}): string {
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

export default async function AccessGrantsPage() {
  await requireOrgAdmin();

  const grants = await getPrisma().accessGrant.findMany({
    orderBy: { requestedAt: 'desc' },
    take: 100,
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">Access grants</h1>
          <p className="text-sm text-white/50">
            Time-boxed, audited transcript access (§8.4). Approve a request to grant access for a
            bounded window; revoke any time. The viewed user sees every grant in their audit feed.
          </p>
        </div>
        <a
          href="/admin/access-grants/new"
          className="rounded-md bg-brand-500 px-3 py-1.5 text-sm font-medium hover:bg-brand-600"
        >
          New request
        </a>
      </div>

      {grants.length === 0 && <p className="text-sm text-white/40">No access grants yet.</p>}

      <div className="space-y-3">
        {grants.map((g) => {
          const st = status(g);
          return (
            <div
              key={g.id}
              className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-2 text-sm"
            >
              <div className="flex items-center gap-2 text-xs text-white/40">
                <span className="rounded bg-white/10 px-1.5 py-0.5 text-white/70">{st}</span>
                <span>· scope: {g.scope}</span>
                {g.expiresAt && <span>· expires {new Date(g.expiresAt).toLocaleString()}</span>}
              </div>
              <p className="text-white/70">{g.justification}</p>
              <p className="text-xs text-white/40 font-mono">
                {g.scope === 'single_session'
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
                      className="w-20 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-right text-xs"
                    />
                    <button
                      type="submit"
                      className="rounded-md bg-brand-500 px-3 py-1 text-xs font-medium hover:bg-brand-600"
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
                      className="rounded-md border border-red-500/40 px-3 py-1 text-xs text-red-300 hover:bg-red-500/10"
                    >
                      Revoke
                    </button>
                  </form>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
