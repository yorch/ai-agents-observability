import {
  BUDGET_THRESHOLD_WINDOW_DAYS,
  parseBudgetThresholdParams,
} from '@ai-agents-observability/schemas';
import { getPrisma } from '@/lib/prisma';
import { requireOrgAdmin } from '@/lib/roles';
import {
  acknowledgeAlert,
  addChannel,
  deleteChannel,
  silenceRule,
  toggleChannel,
  toggleRule,
  unsilenceRule,
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
        <h1 className="font-display text-xl font-semibold tracking-tight text-text">Alerts</h1>
        <p className="text-sm text-text-2">
          Rules, notification channels, and history. Notifications carry aggregate signals only —
          never session ids, user handles, or transcript content.
        </p>
      </div>

      {/* Rules */}
      <section className="space-y-2">
        <h2 className="text-sm font-medium text-text">Rules</h2>
        <div className="space-y-2">
          {rules.map((r) => {
            const isBudget = r.ruleType === 'budget_threshold';
            const budgetParams = isBudget ? parseBudgetThresholdParams(r.params) : null;
            const budgetUsd = budgetParams?.budgetUsd;
            const windowDays = budgetParams?.windowDays ?? BUDGET_THRESHOLD_WINDOW_DAYS;
            const silenced = r.silencedUntil != null && new Date(r.silencedUntil) > new Date();
            return (
              <div
                key={r.id}
                className="space-y-2 rounded-md border border-border bg-surface px-3 py-2 text-sm"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    {r.name} <span className="text-text-3">({r.ruleType})</span>
                    {silenced && r.silencedUntil && (
                      <span className="ml-2 text-warn">
                        · silenced until {new Date(r.silencedUntil).toLocaleString()}
                      </span>
                    )}
                  </span>
                  <div className="flex items-center gap-2">
                    {silenced ? (
                      <form action={unsilenceRule}>
                        <input type="hidden" name="id" value={r.id} />
                        <button
                          type="submit"
                          className="rounded-md border border-border px-3 py-1 text-xs hover:bg-surface-2"
                        >
                          Unsilence
                        </button>
                      </form>
                    ) : (
                      <form action={silenceRule} className="flex items-center gap-1">
                        <input type="hidden" name="id" value={r.id} />
                        <select
                          name="hours"
                          defaultValue="4"
                          aria-label={`Silence ${r.name} for`}
                          className="rounded-md border border-border bg-surface px-2 py-1 text-xs"
                        >
                          <option value="1">1h</option>
                          <option value="4">4h</option>
                          <option value="24">24h</option>
                          <option value="72">72h</option>
                        </select>
                        <button
                          type="submit"
                          className="rounded-md border border-border px-3 py-1 text-xs hover:bg-surface-2"
                        >
                          Silence
                        </button>
                      </form>
                    )}
                    <form action={toggleRule}>
                      <input type="hidden" name="id" value={r.id} />
                      <input type="hidden" name="enabled" value={(!r.enabled).toString()} />
                      <button
                        type="submit"
                        className={`rounded-md px-3 py-1 text-xs ${r.enabled ? 'bg-accent/80 hover:opacity-90 text-bg' : 'border border-border hover:bg-surface-2'}`}
                      >
                        {r.enabled ? 'Enabled' : 'Disabled'}
                      </button>
                    </form>
                  </div>
                </div>
                {isBudget && (
                  <form action={updateBudgetThreshold} className="flex flex-wrap items-end gap-2">
                    <input type="hidden" name="id" value={r.id} />
                    <label className="flex flex-col gap-1 text-xs text-text-2">
                      Budget (USD)
                      <input
                        name="budgetUsd"
                        type="number"
                        min="1"
                        step="0.01"
                        defaultValue={budgetUsd ?? ''}
                        placeholder="e.g. 5000"
                        className="w-32 rounded-md border border-border bg-surface px-2 py-1 text-sm"
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-xs text-text-2">
                      Window (days)
                      <input
                        name="windowDays"
                        type="number"
                        min="1"
                        step="1"
                        defaultValue={windowDays}
                        className="w-24 rounded-md border border-border bg-surface px-2 py-1 text-sm"
                      />
                    </label>
                    <button
                      type="submit"
                      className="rounded-md border border-border px-3 py-1 text-xs hover:bg-surface-2"
                    >
                      Save budget
                    </button>
                    {budgetUsd === undefined && (
                      <span className="text-xs text-warn">Set a budget to activate this rule.</span>
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
        <h2 className="text-sm font-medium text-text">Channels</h2>
        {channels.map((c) => (
          <div
            key={c.id}
            className="flex items-center justify-between rounded-md border border-border bg-surface px-3 py-2 text-sm"
          >
            <span>
              {c.channelType} <span className="text-text-3">{c.enabled ? '' : '(disabled)'}</span>
            </span>
            <div className="flex gap-2">
              <form action={toggleChannel}>
                <input type="hidden" name="id" value={c.id} />
                <input type="hidden" name="enabled" value={(!c.enabled).toString()} />
                <button
                  type="submit"
                  className="rounded-md border border-border px-3 py-1 text-xs hover:bg-surface-2"
                >
                  {c.enabled ? 'Disable' : 'Enable'}
                </button>
              </form>
              <form action={deleteChannel}>
                <input type="hidden" name="id" value={c.id} />
                <button
                  type="submit"
                  className="rounded-md border border-crit-line px-3 py-1 text-xs text-crit hover:bg-crit-soft"
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
            className="rounded-md border border-border bg-surface px-2 py-1 text-sm"
          >
            <option value="webhook">webhook</option>
            <option value="slack_webhook">slack_webhook</option>
            <option value="email">email</option>
          </select>
          <input
            name="target"
            placeholder="https://… or email@…"
            aria-label="Channel target"
            className="flex-1 min-w-64 rounded-md border border-border bg-surface px-3 py-1 text-sm"
          />
          <button
            type="submit"
            className="rounded-md bg-accent px-3 py-1 text-sm font-medium text-bg hover:opacity-90"
          >
            Add channel
          </button>
        </form>
      </section>

      {/* Recent delivery failures */}
      {failures.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium text-warn">Recent delivery failures</h2>
          {failures.map((f) => (
            <p key={f.id.toString()} className="text-xs text-text-2">
              {new Date(f.attemptedAt).toLocaleString()} · {f.channelType} · {f.error}
            </p>
          ))}
        </section>
      )}

      {/* History (aggregate only) */}
      <section className="space-y-2">
        <h2 className="text-sm font-medium text-text">History</h2>
        {history.length === 0 ? (
          <p className="text-sm text-text-3">No alerts have fired.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-text-3 border-b border-border">
                <th className="pb-2 font-medium">Rule</th>
                <th className="pb-2 font-medium">Severity</th>
                <th className="pb-2 font-medium">Fired</th>
                <th className="pb-2 font-medium">Resolved</th>
                <th className="pb-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {history.map((e) => (
                <tr key={e.id.toString()}>
                  <td className="py-2">{e.rule.name}</td>
                  <td className="py-2">{e.severity}</td>
                  <td className="py-2 text-text-2">{new Date(e.firedAt).toLocaleString()}</td>
                  <td className="py-2 text-text-2">
                    {e.resolvedAt ? new Date(e.resolvedAt).toLocaleString() : '—'}
                  </td>
                  <td className="py-2">
                    {e.acknowledgedAt ? (
                      <span className="text-text-3">acknowledged</span>
                    ) : e.resolvedAt ? (
                      <span className="text-text-3">—</span>
                    ) : (
                      <form action={acknowledgeAlert}>
                        <input type="hidden" name="id" value={e.id.toString()} />
                        <button
                          type="submit"
                          className="rounded-md border border-border px-3 py-1 text-xs hover:bg-surface-2"
                        >
                          Acknowledge
                        </button>
                      </form>
                    )}
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
