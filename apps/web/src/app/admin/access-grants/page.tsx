import { ActionForm, Button, ButtonLink, Card, ConfirmButton, Input } from '@/components/ui';
import { getTranslations } from '@/i18n/server';
import { fmtDateTime } from '@/lib/fmt';
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
function HoursInput({
  dict,
  label,
}: {
  dict: import('@/i18n/dictionary').Dictionary;
  label: string;
}) {
  return (
    <Input
      size="sm"
      type="number"
      name="hours"
      min={1}
      placeholder={dict.admin.accessGrants.hoursPlaceholder}
      aria-label={label}
      className="w-20 text-right"
    />
  );
}

function GrantCard({ dict, g }: { dict: import('@/i18n/dictionary').Dictionary; g: Grant }) {
  const st = status(g);
  return (
    <Card className="text-sm" contentClassName="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-text-3">
        <span className="rounded bg-surface-2 px-1.5 py-0.5 text-text-2">{st}</span>
        <span>· scope: {g.scope}</span>
        {g.expiresAt && <span>· expires {fmtDateTime(new Date(g.expiresAt))} UTC</span>}
        {expiringSoon(g) && (
          <span className="rounded bg-warn-soft px-1.5 py-0.5 text-warn">
            {dict.admin.accessGrants.expiringSoon}
          </span>
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
          <ActionForm action={approveGrant} className="inline-flex flex-wrap items-center gap-2">
            <input type="hidden" name="id" value={g.id} />
            <HoursInput dict={dict} label={dict.admin.accessGrants.grantLifetime} />
            <Button size="sm" type="submit">
              Approve (h)
            </Button>
          </ActionForm>
        )}
        {st === 'active' && (
          <ActionForm action={revokeGrant}>
            <input type="hidden" name="id" value={g.id} />
            <ConfirmButton
              size="sm"
              confirmMessage="Revoke this access grant? The grantee loses access immediately."
            >
              Revoke
            </ConfirmButton>
          </ActionForm>
        )}
      </div>
    </Card>
  );
}

export default async function AccessGrantsPage() {
  await requireOrgAdmin();
  const { dict } = await getTranslations();

  const grants = await getPrisma().accessGrant.findMany({
    orderBy: { requestedAt: 'desc' },
    take: 100,
  });

  const pending = grants.filter((g) => status(g) === 'pending');
  const rest = grants.filter((g) => status(g) !== 'pending');

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
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
            <ActionForm
              action={approveAllPending}
              className="inline-flex flex-wrap items-center gap-2"
            >
              <HoursInput dict={dict} label={dict.admin.accessGrants.bulkLifetime} />
              {/* Secondary, not the accent: a bulk approve should not outweigh
                  the per-row approvals it stands next to. */}
              <ConfirmButton
                variant="secondary"
                size="sm"
                confirmMessage={`Approve all ${pending.length} pending grant requests? Each approval is audit-logged and visible to the affected users.`}
              >
                Approve all ({pending.length})
              </ConfirmButton>
            </ActionForm>
          )}
        </div>
        {pending.length === 0 ? (
          <p className="text-sm text-text-3">{dict.admin.accessGrants.emptyPending}</p>
        ) : (
          <div className="space-y-3">
            {pending.map((g) => (
              <GrantCard key={g.id} dict={dict} g={g} />
            ))}
          </div>
        )}
      </section>

      {/* All other grants. */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-text">{dict.admin.accessGrants.allGrants}</h2>
        {rest.length === 0 ? (
          <p className="text-sm text-text-3">{dict.admin.accessGrants.emptyAll}</p>
        ) : (
          <div className="space-y-3">
            {rest.map((g) => (
              <GrantCard key={g.id} dict={dict} g={g} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
