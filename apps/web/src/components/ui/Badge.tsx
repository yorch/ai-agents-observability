import type { ReactNode } from 'react';

export type BadgeTone = 'good' | 'warn' | 'crit' | 'neutral' | 'accent';

const TONE: Record<BadgeTone, string> = {
  accent: 'text-accent border-accent/40 bg-accent-dim',
  crit: 'text-crit border-crit-line bg-crit-soft',
  good: 'text-good border-good-line bg-good-soft',
  neutral: 'text-text-2 border-border bg-surface-2',
  warn: 'text-warn border-warn-line bg-warn-soft',
};

/**
 * Status pill. State is carried by the label as well as the tone, so it never
 * depends on colour alone.
 */
export function Badge({
  children,
  dot = true,
  tone = 'neutral',
}: {
  children: ReactNode;
  /** The leading dot. Drop it for badges that already carry an icon. */
  dot?: boolean;
  tone?: BadgeTone;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${TONE[tone]}`}
    >
      {dot && <span className="h-1 w-1 shrink-0 rounded-full bg-current" />}
      {children}
    </span>
  );
}

/** Tone as bare ink / fill, for callers that need the colour without the pill. */
export const TONE_TEXT: Record<BadgeTone, string> = {
  accent: 'text-accent',
  crit: 'text-crit',
  good: 'text-good',
  neutral: 'text-text-2',
  warn: 'text-warn',
};

export const TONE_BG: Record<BadgeTone, string> = {
  accent: 'bg-accent',
  crit: 'bg-crit',
  good: 'bg-good',
  neutral: 'bg-surface-3',
  warn: 'bg-warn',
};

const SERIES_BADGE = [
  'border-series-1/40 bg-series-1/15 text-series-1',
  'border-series-2/40 bg-series-2/15 text-series-2',
  'border-series-3/40 bg-series-3/15 text-series-3',
  'border-series-4/40 bg-series-4/15 text-series-4',
  'border-series-5/40 bg-series-5/15 text-series-5',
  'border-series-6/40 bg-series-6/15 text-series-6',
] as const;

/**
 * Badge for a member of a categorical set — a session shape, an agent kind.
 * Distinct from `Badge`, whose tones are reserved for state: a category is not
 * good or bad, and colouring it as though it were misreads the data.
 *
 * `index` is the entity's fixed position, so a category keeps its colour
 * regardless of what else is on screen. `null` renders neutral, for members
 * that mean "none" rather than a real category.
 */
export function SeriesBadge({ children, index }: { children: ReactNode; index: number | null }) {
  const cls = index === null ? TONE.neutral : (SERIES_BADGE[index] ?? TONE.neutral);
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px] tracking-wider ${cls}`}
    >
      {children}
    </span>
  );
}
