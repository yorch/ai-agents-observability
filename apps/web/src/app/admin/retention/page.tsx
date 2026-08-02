import { Button, Cell, Input, Row, Table } from '@/components/ui';
import { getPrisma } from '@/lib/prisma';
import { requireOrgAdmin } from '@/lib/roles';
import { setTeamRetention } from './actions';

export const dynamic = 'force-dynamic';

// The web app doesn't own the sweep config, but it knows the documented defaults
// so it can show the *effective* retention to the admin. Keep in sync with
// apps/ingest/src/config.ts.
const GLOBAL_DEFAULT_DAYS = Number(process.env.TRANSCRIPT_RETENTION_DAYS ?? '365');
const ORG_MAX_DAYS = Number(process.env.ORG_MAX_RETENTION_DAYS ?? '730');

function effectiveDays(override: number | null): number {
  return Math.min(override ?? GLOBAL_DEFAULT_DAYS, ORG_MAX_DAYS);
}

export default async function RetentionAdminPage() {
  await requireOrgAdmin();

  const teams = await getPrisma().team.findMany({
    orderBy: { name: 'asc' },
    select: { githubSlug: true, id: true, name: true, retentionDays: true },
  });

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="font-display text-xl font-semibold tracking-tight text-text">
          Transcript retention
        </h1>
        <p className="text-sm text-text-2">
          Per-team transcript retention overrides. Blank = global default ({GLOBAL_DEFAULT_DAYS}{' '}
          days). Overrides are clamped to the org maximum ({ORG_MAX_DAYS} days). Changes are
          audited.
        </p>
      </div>

      {teams.length === 0 && <p className="text-sm text-text-3">No teams synced yet.</p>}

      <Table
        columns={[
          { label: 'Team' },
          { align: 'right', label: 'Override (days)' },
          { align: 'right', label: 'Effective' },
          { label: '' },
        ]}
      >
        {teams.map((team) => (
          <Row key={team.id}>
            <Cell>
              {team.name} <span className="text-text-3">{team.githubSlug}</span>
            </Cell>
            <Cell num>
              <form action={setTeamRetention} className="inline-flex items-center gap-2">
                <input type="hidden" name="teamId" value={team.id} />
                <Input
                  size="sm"
                  type="number"
                  name="retentionDays"
                  min={1}
                  max={ORG_MAX_DAYS}
                  defaultValue={team.retentionDays ?? ''}
                  placeholder={`${GLOBAL_DEFAULT_DAYS}`}
                  aria-label={`Retention override for ${team.name}`}
                  className="w-24 text-right"
                />
                <Button size="sm" type="submit">
                  Save
                </Button>
              </form>
            </Cell>
            <Cell num className="text-text-2">
              {effectiveDays(team.retentionDays)}d
              {team.retentionDays === null && <span className="ml-1 text-text-3">(default)</span>}
            </Cell>
            <Cell></Cell>
          </Row>
        ))}
      </Table>
    </div>
  );
}
