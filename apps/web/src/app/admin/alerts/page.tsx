import {
  BUDGET_THRESHOLD_WINDOW_DAYS,
  parseBudgetThresholdParams,
} from '@ai-agents-observability/schemas';
import {
  ActionForm,
  Button,
  Cell,
  ConfirmButton,
  Field,
  Input,
  Row,
  Select,
  Table,
} from '@/components/ui';
import { fmtDateTime } from '@/lib/fmt';
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
                        · silenced until {fmtDateTime(new Date(r.silencedUntil))} UTC
                      </span>
                    )}
                  </span>
                  <div className="flex items-center gap-2">
                    {silenced ? (
                      <ActionForm action={unsilenceRule}>
                        <input type="hidden" name="id" value={r.id} />
                        <Button variant="secondary" size="sm" type="submit">
                          Unsilence
                        </Button>
                      </ActionForm>
                    ) : (
                      <ActionForm
                        action={silenceRule}
                        className="flex flex-wrap items-center gap-1"
                      >
                        <input type="hidden" name="id" value={r.id} />
                        <Select
                          size="sm"
                          name="hours"
                          defaultValue="4"
                          aria-label={`Silence ${r.name} for`}
                        >
                          <option value="1">1h</option>
                          <option value="4">4h</option>
                          <option value="24">24h</option>
                          <option value="72">72h</option>
                        </Select>
                        <Button variant="secondary" size="sm" type="submit">
                          Silence
                        </Button>
                      </ActionForm>
                    )}
                    <ActionForm action={toggleRule}>
                      <input type="hidden" name="id" value={r.id} />
                      <input type="hidden" name="enabled" value={(!r.enabled).toString()} />
                      <Button type="submit" size="sm" variant={r.enabled ? 'primary' : 'secondary'}>
                        {r.enabled ? 'Enabled' : 'Disabled'}
                      </Button>
                    </ActionForm>
                  </div>
                </div>
                {isBudget && (
                  <ActionForm
                    action={updateBudgetThreshold}
                    className="flex flex-wrap items-end gap-2"
                  >
                    <input type="hidden" name="id" value={r.id} />
                    <Field label="Budget (USD)" htmlFor={`budget-${r.id}`} className="w-32">
                      <Input
                        size="sm"
                        id={`budget-${r.id}`}
                        name="budgetUsd"
                        type="number"
                        min="1"
                        step="0.01"
                        defaultValue={budgetUsd ?? ''}
                        placeholder="e.g. 5000"
                      />
                    </Field>
                    <Field label="Window (days)" htmlFor={`window-${r.id}`} className="w-24">
                      <Input
                        size="sm"
                        id={`window-${r.id}`}
                        name="windowDays"
                        type="number"
                        min="1"
                        step="1"
                        defaultValue={windowDays}
                      />
                    </Field>
                    <Button variant="secondary" size="sm" type="submit">
                      Save budget
                    </Button>
                    {budgetUsd === undefined && (
                      <span className="text-xs text-warn">Set a budget to activate this rule.</span>
                    )}
                  </ActionForm>
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
              <ActionForm action={toggleChannel}>
                <input type="hidden" name="id" value={c.id} />
                <input type="hidden" name="enabled" value={(!c.enabled).toString()} />
                <Button variant="secondary" size="sm" type="submit">
                  {c.enabled ? 'Disable' : 'Enable'}
                </Button>
              </ActionForm>
              <ActionForm action={deleteChannel}>
                <input type="hidden" name="id" value={c.id} />
                <ConfirmButton
                  size="sm"
                  confirmMessage="Remove this notification channel? Alerts will stop delivering to it."
                >
                  Remove
                </ConfirmButton>
              </ActionForm>
            </div>
          </div>
        ))}
        <ActionForm action={addChannel} className="flex flex-wrap items-end gap-2 pt-2">
          <Select size="sm" name="channelType" defaultValue="webhook" aria-label="Channel type">
            <option value="webhook">webhook</option>
            <option value="slack_webhook">slack_webhook</option>
            <option value="email">email</option>
          </Select>
          <Input
            size="sm"
            name="target"
            placeholder="https://… or email@…"
            aria-label="Channel target"
            className="min-w-64 flex-1"
          />
          <Button size="sm" type="submit">
            Add channel
          </Button>
        </ActionForm>
      </section>

      {/* Recent delivery failures */}
      {failures.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium text-warn">Recent delivery failures</h2>
          {failures.map((f) => (
            <p key={f.id.toString()} className="text-xs text-text-2">
              {fmtDateTime(new Date(f.attemptedAt))} UTC · {f.channelType} · {f.error}
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
          <Table
            columns={[
              { label: 'Rule' },
              { label: 'Severity' },
              { label: 'Fired' },
              { label: 'Resolved' },
              { label: 'Status' },
            ]}
          >
            {history.map((e) => (
              <Row key={e.id.toString()}>
                <Cell>{e.rule.name}</Cell>
                <Cell>{e.severity}</Cell>
                <Cell className="text-text-2">{fmtDateTime(new Date(e.firedAt))} UTC</Cell>
                <Cell className="text-text-2">
                  {e.resolvedAt ? `${fmtDateTime(new Date(e.resolvedAt))} UTC` : '—'}
                </Cell>
                <Cell>
                  {e.acknowledgedAt ? (
                    <span className="text-text-3">acknowledged</span>
                  ) : e.resolvedAt ? (
                    <span className="text-text-3">—</span>
                  ) : (
                    <ActionForm action={acknowledgeAlert}>
                      <input type="hidden" name="id" value={e.id.toString()} />
                      <Button variant="secondary" size="sm" type="submit">
                        Acknowledge
                      </Button>
                    </ActionForm>
                  )}
                </Cell>
              </Row>
            ))}
          </Table>
        )}
      </section>
    </div>
  );
}
