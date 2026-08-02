import { Button, ButtonLink, Card, Input } from '@/components/ui';
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

/** The grant-lifetime box, identical on the per-row and bulk approve forms. */
function HoursInput({ label }: { label: string }) {
  return (
    <Input
      size="sm"
      type="number"
      name="hours"
      min={1}
      placeholder="48"
      aria-label={label}
      className="w-20 text-right"
    />
  );
}

function GrantCard({ g }: { g: Grant }) {
  const st = status(g);
  return (
    <Card className="text-sm" contentClassName="space-y-2">
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
            <HoursInput label="Grant lifetime (hours)" />
            <Button size="sm" type="submit">
              Approve (h)
            </Button>
          </form>
        )}
        {st === 'active' && (
          <form action={revokeGrant}>
            <input type="hidden" name="id" value={g.id} />
            <Button variant="danger" size="sm" type="submit">
              Revoke
            </Button>
          </form>
        )}
      </div>
    </Card>
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
        <ButtonLink size="sm" href="/admin/access-grants/new">
          New request
        </ButtonLink>
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
              <HoursInput label="Bulk grant lifetime (hours)" />
              {/* Secondary, not the accent: a bulk approve should not outweigh
                  the per-row approvals it stands next to. */}
              <Button variant="secondary" size="sm" type="submit">
                Approve all ({pending.length})
              </Button>
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
