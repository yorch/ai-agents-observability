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
