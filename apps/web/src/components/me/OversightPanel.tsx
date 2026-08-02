import { Card, ShareBar, Stat } from '@/components/ui';
import { fmtDurationOrDash, fmtPct } from '@/lib/fmt';
import type { OversightSummary } from '@/lib/oversight-queries';

// Oversight & Autonomy panel (R4) + over-trust callout (R5). Pure presentational
// server component: renders the autonomy-mode mix, approval friction, and human
// response latency captured in R1–R3.

// Autonomy modes are a categorical set, not a severity scale — they take the
// chart series palette in fixed order so a mode keeps its colour whatever the
// mix. Risk is conveyed by the over-trust callout below, not by hue.
const MODE_COLOR: Record<string, string> = {
  accept_edits: 'bg-series-2',
  auto: 'bg-series-5',
  bypass: 'bg-series-6',
  dont_ask: 'bg-series-4',
  normal: 'bg-series-1',
  plan: 'bg-series-3',
};

const MODE_LABEL: Record<string, string> = {
  accept_edits: 'accept edits',
  auto: 'auto',
  bypass: 'bypass',
  dont_ask: "don't ask",
  normal: 'default',
  plan: 'plan',
};

export function OversightPanel({ data }: { data: OversightSummary }) {
  if (data.totalSessions === 0) {
    return null;
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-text-3 uppercase tracking-widest">Oversight &amp; autonomy</p>

      {data.rubberStamp && (
        <div className="rounded-lg border border-crit-line bg-crit-soft p-3 text-sm text-crit">
          <span className="font-semibold">Heads up — oversight looks reflexive.</span> Most sessions
          ran with no per-action gate, denials are near zero, and responses to prompts are very
          fast. Worth a second look at a recent autonomous session before trusting the next one.
        </div>
      )}

      {/* Autonomy mode mix */}
      <Card>
        <div className="flex items-baseline justify-between">
          <p className="text-sm font-medium text-text">Autonomy mix</p>
          <p className="text-xs text-text-3">
            {fmtPct(data.lowOversightShare)} ungated · {data.totalSessions} sessions
          </p>
        </div>
        <div className="mt-3">
          <ShareBar
            total={data.totalSessions}
            segments={data.modeMix.map((m) => ({
              className: MODE_COLOR[m.mode] ?? 'bg-surface-3',
              key: m.mode,
              title: `${MODE_LABEL[m.mode] ?? m.mode}: ${m.count}`,
              value: m.count,
            }))}
          />
        </div>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
          {data.modeMix.map((m) => (
            <span key={m.mode} className="flex items-center gap-1.5 text-xs text-text-2">
              <span className={`h-2 w-2 rounded-full ${MODE_COLOR[m.mode] ?? 'bg-surface-3'}`} />
              {MODE_LABEL[m.mode] ?? m.mode} ({m.count})
            </span>
          ))}
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat
          label="Denial rate"
          value={fmtPct(data.denyRate)}
          sub={`${data.permissionDenyCount}/${data.toolCallCount} tool calls`}
        />
        <Stat
          label="Avg response"
          value={fmtDurationOrDash(data.avgResponseMs)}
          sub={`${data.responseSampleCount} prompts`}
        />
        <Stat
          label="Prompts"
          value={data.permissionPromptCount.toLocaleString()}
          sub="permission"
        />
        <Stat label="Interrupts" value={data.interruptCount.toLocaleString()} sub="by you" />
      </div>
    </div>
  );
}
