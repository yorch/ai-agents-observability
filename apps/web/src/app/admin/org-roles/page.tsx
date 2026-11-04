import { OrgRole } from '@ai-agents-observability/db';
import { ActionForm, Button, Cell, PageHeader, Row, Select, Table } from '@/components/ui';
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

const ORG_ROLE_LABEL: Record<OrgRole, { description: string; label: string }> = {
  [OrgRole.MEMBER]: {
    description: 'Sees only their own sessions. No org-wide views.',
    label: 'Member',
  },
  [OrgRole.VIEWER_AGGREGATE]: {
    description: 'Org dashboards and aggregate numbers. No individual sessions.',
    label: 'Aggregate viewer',
  },
  [OrgRole.INVESTIGATOR]: {
    description:
      'Aggregate access, and can request time-boxed transcript grants. Never standing access to individual sessions.',
    label: 'Investigator',
  },
  [OrgRole.ORG_ADMIN]: {
    description: 'Approves access grants and manages org roles.',
    label: 'Org admin',
  },
};

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
      <PageHeader
        breadcrumb="Admin"
        title="Org roles"
        description="Assign org-level roles. Changes are audited."
      />

      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
        {ROLES.map((r) => (
          <div key={r} className="contents">
            <dt className="font-medium text-text">{ORG_ROLE_LABEL[r].label}</dt>
            <dd className="text-text-2">{ORG_ROLE_LABEL[r].description}</dd>
          </div>
        ))}
      </dl>

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
                      {ORG_ROLE_LABEL[r].label}
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
