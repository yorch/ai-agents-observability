import { OrgRole } from '@ai-agents-observability/db';
import { getPrisma } from '@/lib/prisma';
import { requireOrgAdmin } from '@/lib/roles';
import { setOrgRole } from './actions';

export const dynamic = 'force-dynamic';

const ROLES: OrgRole[] = [
  OrgRole.MEMBER,
  OrgRole.VIEWER_AGGREGATE,
  OrgRole.INVESTIGATOR,
  OrgRole.ORG_ADMIN,
];

export default async function OrgRolesAdminPage() {
  await requireOrgAdmin();

  const users = await getPrisma().user.findMany({
    orderBy: [{ orgRole: 'asc' }, { githubLogin: 'asc' }],
    select: { displayName: true, githubLogin: true, id: true, orgRole: true },
    take: 500,
    where: { deactivatedAt: null },
  });

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">Org roles</h1>
        <p className="text-sm text-text-2">
          Assign org-level roles. <span className="text-text-2">investigator</span> grants aggregate
          access plus the ability to request time-boxed access grants — never standing access to
          individual sessions. Changes are audited.
        </p>
      </div>

      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-text-3 border-b border-border">
            <th className="pb-2 font-medium">User</th>
            <th className="pb-2 font-medium">Role</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border-subtle">
          {users.map((u) => (
            <tr key={u.id}>
              <td className="py-2">
                {u.displayName ?? u.githubLogin ?? u.id.slice(0, 8)}{' '}
                <span className="text-text-3">{u.githubLogin}</span>
              </td>
              <td className="py-2">
                <form action={setOrgRole} className="inline-flex items-center gap-2">
                  <input type="hidden" name="userId" value={u.id} />
                  <select
                    name="role"
                    defaultValue={u.orgRole}
                    aria-label={`Org role for ${u.githubLogin ?? u.id}`}
                    className="rounded-md border border-border bg-surface px-2 py-1"
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                  <button
                    type="submit"
                    className="rounded-md bg-brand-500 px-3 py-1 text-xs font-medium text-bg hover:bg-brand-600"
                  >
                    Save
                  </button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
