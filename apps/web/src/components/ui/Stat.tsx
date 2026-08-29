import { ArrowDownIcon, ArrowUpIcon } from '@/components/icons';

type Accent = 'good' | 'warn' | 'crit';

const ACCENT_CLASS: Record<Accent, string> = {
  crit: 'text-crit',
  good: 'text-good',
  warn: 'text-warn',
};

type StatProps = {
  /**
   * Tints the value. Use only when the number itself carries state.
   * Explicitly `| undefined` so callers can write `accent={cond ? 'crit' : undefined}`
   * under exactOptionalPropertyTypes instead of spreading a conditional object.
   */
  accent?: Accent | undefined;
  /** Period-over-period change as a fraction (0.182 renders as +18%). */
  delta?: number | null;
  /**
   * Set for metrics where up is bad (spend, friction, error rate) so a rise
   * reads as warning rather than success.
   */
  deltaInverted?: boolean;
  label: string;
  /** Small mono text below the value — unit hints like "target: 40–60%". */
  note?: string;
  /** Small regular text below the value — e.g. "vs. previous period". */
  sub?: string;
  value: string;
};

/**
 * Signed percent with a direction arrow. Exported because summary blocks
 * outside a Stat tile need the same treatment.
 */
export function Delta({ value, inverted }: { value: number; inverted: boolean }) {
  const pct = Math.round(value * 100);
  if (pct === 0) {
    return <span className="font-mono text-xs text-text-3">±0%</span>;
  }
  const up = pct > 0;
  // "Good" means the metric moved the way you want, which depends on the metric.
  const favourable = inverted ? !up : up;
  return (
    <span
      className={`inline-flex items-center gap-1 font-mono text-xs ${
        favourable ? 'text-good' : 'text-warn'
      }`}
    >
      {up ? <ArrowUpIcon size={12} /> : <ArrowDownIcon size={12} />}
      {Math.abs(pct)}%
    </span>
  );
}

/** The stat tile. Every summary number in the app is one of these. */
export function Stat({ accent, delta, deltaInverted = false, label, note, sub, value }: StatProps) {
  return (
    <div className="space-y-1 rounded-lg border border-border bg-surface p-4">
      <p className="text-xs uppercase tracking-wider text-text-3">{label}</p>
      <p
        className={`font-mono text-2xl font-semibold break-words ${accent ? ACCENT_CLASS[accent] : 'text-text'}`}
      >
        {value}
      </p>
      {delta !== null && delta !== undefined && <Delta value={delta} inverted={deltaInverted} />}
      {sub && <p className="text-xs text-text-3">{sub}</p>}
      {note && <p className="font-mono text-[10px] text-text-3">{note}</p>}
    </div>
  );
}
