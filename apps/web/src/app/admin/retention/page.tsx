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
        <h1 className="text-xl font-semibold">Transcript retention</h1>
        <p className="text-sm text-white/50">
          Per-team transcript retention overrides. Blank = global default ({GLOBAL_DEFAULT_DAYS}{' '}
          days). Overrides are clamped to the org maximum ({ORG_MAX_DAYS} days). Changes are
          audited.
        </p>
      </div>

      {teams.length === 0 && <p className="text-sm text-white/40">No teams synced yet.</p>}

      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-white/40 border-b border-white/10">
            <th className="pb-2 font-medium">Team</th>
            <th className="pb-2 font-medium text-right">Override (days)</th>
            <th className="pb-2 font-medium text-right">Effective</th>
            <th className="pb-2 font-medium" />
          </tr>
        </thead>
        <tbody className="divide-y divide-white/5">
          {teams.map((team) => (
            <tr key={team.id}>
              <td className="py-2">
                {team.name} <span className="text-white/30">{team.githubSlug}</span>
              </td>
              <td className="py-2 text-right">
                <form action={setTeamRetention} className="inline-flex items-center gap-2">
                  <input type="hidden" name="teamId" value={team.id} />
                  <input
                    type="number"
                    name="retentionDays"
                    min={1}
                    max={ORG_MAX_DAYS}
                    defaultValue={team.retentionDays ?? ''}
                    placeholder={`${GLOBAL_DEFAULT_DAYS}`}
                    aria-label={`Retention override for ${team.name}`}
                    className="w-24 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-right"
                  />
                  <button
                    type="submit"
                    className="rounded-md bg-brand-500 px-3 py-1 text-xs font-medium hover:bg-brand-600"
                  >
                    Save
                  </button>
                </form>
              </td>
              <td className="py-2 text-right font-mono text-white/60">
                {effectiveDays(team.retentionDays)}d
                {team.retentionDays === null && (
                  <span className="ml-1 text-white/30">(default)</span>
                )}
              </td>
              <td className="py-2" />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
