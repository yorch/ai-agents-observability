import type { OversightSummary } from '@/lib/oversight-queries';

// Oversight & Autonomy panel (R4) + over-trust callout (R5). Pure presentational
// server component: renders the autonomy-mode mix, approval friction, and human
// response latency captured in R1–R3.

const MODE_COLOR: Record<string, string> = {
  accept_edits: 'bg-yellow-500',
  auto: 'bg-amber-500',
  bypass: 'bg-red-500',
  dont_ask: 'bg-orange-500',
  normal: 'bg-sky-500',
  plan: 'bg-emerald-500',
};

const MODE_LABEL: Record<string, string> = {
  accept_edits: 'accept edits',
  auto: 'auto',
  bypass: 'bypass',
  dont_ask: "don't ask",
  normal: 'default',
  plan: 'plan',
};

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

function humanMs(ms: number | null): string {
  if (ms === null) {
    return '—';
  }
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  return `${(ms / 60_000).toFixed(1)}m`;
}

function Tile({ label, value, sub }: { label: string; sub?: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <p className="text-xs text-text-3 uppercase tracking-widest">{label}</p>
      <p className="mt-1 text-xl font-semibold text-text">{value}</p>
      {sub && <p className="text-xs text-text-3">{sub}</p>}
    </div>
  );
}

export function OversightPanel({ data }: { data: OversightSummary }) {
  if (data.totalSessions === 0) {
    return null;
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-text-3 uppercase tracking-widest">Oversight &amp; autonomy</p>

      {data.rubberStamp && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">
          <span className="font-semibold">Heads up — oversight looks reflexive.</span> Most sessions
          ran with no per-action gate, denials are near zero, and responses to prompts are very
          fast. Worth a second look at a recent autonomous session before trusting the next one.
        </div>
      )}

      {/* Autonomy mode mix */}
      <div className="rounded-lg border border-border bg-surface p-4">
        <div className="flex items-baseline justify-between">
          <p className="text-sm font-medium text-text">Autonomy mix</p>
          <p className="text-xs text-text-3">
            {pct(data.lowOversightShare)} ungated · {data.totalSessions} sessions
          </p>
        </div>
        <div className="mt-3 flex h-3 w-full overflow-hidden rounded-full bg-surface-2">
          {data.modeMix.map((m) => (
            <div
              key={m.mode}
              className={MODE_COLOR[m.mode] ?? 'bg-white/30'}
              style={{ width: `${(m.count / data.totalSessions) * 100}%` }}
              title={`${MODE_LABEL[m.mode] ?? m.mode}: ${m.count}`}
            />
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
          {data.modeMix.map((m) => (
            <span key={m.mode} className="flex items-center gap-1.5 text-xs text-text-2">
              <span className={`h-2 w-2 rounded-full ${MODE_COLOR[m.mode] ?? 'bg-white/30'}`} />
              {MODE_LABEL[m.mode] ?? m.mode} ({m.count})
            </span>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile
          label="Denial rate"
          value={pct(data.denyRate)}
          sub={`${data.permissionDenyCount}/${data.toolCallCount} tool calls`}
        />
        <Tile
          label="Median response"
          value={humanMs(data.avgResponseMs)}
          sub={`${data.responseSampleCount} prompts`}
        />
        <Tile
          label="Prompts"
          value={data.permissionPromptCount.toLocaleString()}
          sub="permission"
        />
        <Tile label="Interrupts" value={data.interruptCount.toLocaleString()} sub="by you" />
      </div>
    </div>
  );
}
