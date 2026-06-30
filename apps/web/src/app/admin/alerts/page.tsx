import {
  BUDGET_THRESHOLD_WINDOW_DAYS,
  parseBudgetThresholdParams,
} from '@ai-agents-observability/schemas';
import { getPrisma } from '@/lib/prisma';
import { requireOrgAdmin } from '@/lib/roles';
import {
  addChannel,
  deleteChannel,
  toggleChannel,
  toggleRule,
  updateBudgetThreshold,
} from './actions';

export const dynamic = 'force-dynamic';

export default async function AlertsAdminPage() {
  await requireOrgAdmin();

  const db = getPrisma();
  const [rules, channels, history, failures] = await Promise.all([
    db.alertRule.findMany({ orderBy: { name: 'asc' } }),
    db.alertChannelConfig.findMany({ orderBy: { createdAt: 'asc' } }),
    // Aggregate-only: rule name + severity + timestamps. NEVER the details JSONB.
    db.alertEvent.findMany({
      include: { rule: { select: { name: true } } },
      orderBy: { firedAt: 'desc' },
      take: 25,
    }),
    db.alertDeliveryLog.findMany({
      orderBy: { attemptedAt: 'desc' },
      take: 10,
      where: { success: false },
    }),
  ]);

  return (
    <div className="space-y-8">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">Alerts</h1>
        <p className="text-sm text-white/50">
          Rules, notification channels, and history. Notifications carry aggregate signals only —
          never session ids, user handles, or transcript content.
        </p>
      </div>

      {/* Rules */}
      <section className="space-y-2">
        <h2 className="text-sm font-medium text-white/80">Rules</h2>
        <div className="space-y-2">
          {rules.map((r) => {
            const isBudget = r.ruleType === 'budget_threshold';
            const budgetParams = isBudget ? parseBudgetThresholdParams(r.params) : null;
            const budgetUsd = budgetParams?.budgetUsd;
            const windowDays = budgetParams?.windowDays ?? BUDGET_THRESHOLD_WINDOW_DAYS;
            return (
              <div
                key={r.id}
                className="space-y-2 rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm"
              >
                <div className="flex items-center justify-between">
                  <span>
                    {r.name} <span className="text-white/30">({r.ruleType})</span>
                  </span>
                  <form action={toggleRule}>
                    <input type="hidden" name="id" value={r.id} />
                    <input type="hidden" name="enabled" value={(!r.enabled).toString()} />
                    <button
                      type="submit"
                      className={`rounded-md px-3 py-1 text-xs ${r.enabled ? 'bg-brand-500/80 hover:bg-brand-600 text-bg' : 'border border-white/10 hover:bg-white/10'}`}
                    >
                      {r.enabled ? 'Enabled' : 'Disabled'}
                    </button>
                  </form>
                </div>
                {isBudget && (
                  <form action={updateBudgetThreshold} className="flex flex-wrap items-end gap-2">
                    <input type="hidden" name="id" value={r.id} />
                    <label className="flex flex-col gap-1 text-xs text-white/50">
                      Budget (USD)
                      <input
                        name="budgetUsd"
                        type="number"
                        min="1"
                        step="0.01"
                        defaultValue={budgetUsd ?? ''}
                        placeholder="e.g. 5000"
                        className="w-32 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-sm"
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-xs text-white/50">
                      Window (days)
                      <input
                        name="windowDays"
                        type="number"
                        min="1"
                        step="1"
                        defaultValue={windowDays}
                        className="w-24 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-sm"
                      />
                    </label>
                    <button
                      type="submit"
                      className="rounded-md border border-white/10 px-3 py-1 text-xs hover:bg-white/10"
                    >
                      Save budget
                    </button>
                    {budgetUsd === undefined && (
                      <span className="text-xs text-yellow-300/70">
                        Set a budget to activate this rule.
                      </span>
                    )}
                  </form>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* Channels */}
      <section className="space-y-2">
        <h2 className="text-sm font-medium text-white/80">Channels</h2>
        {channels.map((c) => (
          <div
            key={c.id}
            className="flex items-center justify-between rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm"
          >
            <span>
              {c.channelType} <span className="text-white/30">{c.enabled ? '' : '(disabled)'}</span>
            </span>
            <div className="flex gap-2">
              <form action={toggleChannel}>
                <input type="hidden" name="id" value={c.id} />
                <input type="hidden" name="enabled" value={(!c.enabled).toString()} />
                <button
                  type="submit"
                  className="rounded-md border border-white/10 px-3 py-1 text-xs hover:bg-white/10"
                >
                  {c.enabled ? 'Disable' : 'Enable'}
                </button>
              </form>
              <form action={deleteChannel}>
                <input type="hidden" name="id" value={c.id} />
                <button
                  type="submit"
                  className="rounded-md border border-red-500/40 px-3 py-1 text-xs text-red-300 hover:bg-red-500/10"
                >
                  Remove
                </button>
              </form>
            </div>
          </div>
        ))}
        <form action={addChannel} className="flex flex-wrap items-end gap-2 pt-2">
          <select
            name="channelType"
            defaultValue="webhook"
            aria-label="Channel type"
            className="rounded-md border border-white/10 bg-white/5 px-2 py-1 text-sm"
          >
            <option value="webhook">webhook</option>
            <option value="slack_webhook">slack_webhook</option>
            <option value="email">email</option>
          </select>
          <input
            name="target"
            placeholder="https://… or email@…"
            aria-label="Channel target"
            className="flex-1 min-w-64 rounded-md border border-white/10 bg-white/5 px-3 py-1 text-sm"
          />
          <button
            type="submit"
            className="rounded-md bg-brand-500 px-3 py-1 text-sm font-medium text-bg hover:bg-brand-600"
          >
            Add channel
          </button>
        </form>
      </section>

      {/* Recent delivery failures */}
      {failures.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium text-yellow-300/80">Recent delivery failures</h2>
          {failures.map((f) => (
            <p key={f.id.toString()} className="text-xs text-white/50">
              {new Date(f.attemptedAt).toLocaleString()} · {f.channelType} · {f.error}
            </p>
          ))}
        </section>
      )}

      {/* History (aggregate only) */}
      <section className="space-y-2">
        <h2 className="text-sm font-medium text-white/80">History</h2>
        {history.length === 0 ? (
          <p className="text-sm text-white/40">No alerts have fired.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-white/40 border-b border-white/10">
                <th className="pb-2 font-medium">Rule</th>
                <th className="pb-2 font-medium">Severity</th>
                <th className="pb-2 font-medium">Fired</th>
                <th className="pb-2 font-medium">Resolved</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {history.map((e) => (
                <tr key={e.id.toString()}>
                  <td className="py-2">{e.rule.name}</td>
                  <td className="py-2">{e.severity}</td>
                  <td className="py-2 text-white/60">{new Date(e.firedAt).toLocaleString()}</td>
                  <td className="py-2 text-white/60">
                    {e.resolvedAt ? new Date(e.resolvedAt).toLocaleString() : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
