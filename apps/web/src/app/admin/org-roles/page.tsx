import { OrgRole } from '@ai-agents-observability/db';
import { ActionForm, Button, Cell, Row, Select, Table } from '@/components/ui';
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
        <h1 className="font-display text-xl font-semibold tracking-tight text-text">Org roles</h1>
        <p className="text-sm text-text-2">
          Assign org-level roles. <span className="text-text-2">investigator</span> grants aggregate
          access plus the ability to request time-boxed access grants — never standing access to
          individual sessions. Changes are audited.
        </p>
      </div>

      <Table columns={[{ label: 'User' }, { label: 'Role' }]}>
        {users.map((u) => (
          <Row key={u.id}>
            <Cell>
              {u.displayName ?? u.githubLogin ?? u.id.slice(0, 8)}{' '}
              <span className="text-text-3">{u.githubLogin}</span>
            </Cell>
            <Cell>
              <ActionForm action={setOrgRole} className="inline-flex flex-wrap items-center gap-2">
                <input type="hidden" name="userId" value={u.id} />
                <Select
                  size="sm"
                  name="role"
                  defaultValue={u.orgRole}
                  aria-label={`Org role for ${u.githubLogin ?? u.id}`}
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </Select>
                <Button size="sm" type="submit">
                  Save
                </Button>
              </ActionForm>
            </Cell>
          </Row>
        ))}
      </Table>
    </div>
  );
}
