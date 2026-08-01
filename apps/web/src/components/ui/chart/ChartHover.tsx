'use client';

import { type ReactNode, useCallback, useRef, useState } from 'react';

type Tip = { label: string; value: string; x: number; y: number };

/**
 * The hover layer for server-rendered charts.
 *
 * Charts stay Server Components: they emit plain SVG whose marks carry
 * `data-tip="label|value"`. This wrapper is the only client code involved — it
 * delegates pointer events from the container, so adding a tooltip costs one
 * listener regardless of how many marks a chart draws.
 */
export function ChartHover({ children }: { children: ReactNode }) {
  const [tip, setTip] = useState<Tip | null>(null);
  const host = useRef<HTMLDivElement>(null);

  const onMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const mark = (e.target as Element).closest?.('[data-tip]');
    const box = host.current?.getBoundingClientRect();
    if (!mark || !box) {
      setTip(null);
      return;
    }
    const raw = mark.getAttribute('data-tip') ?? '';
    const [label, value = ''] = raw.split('|');
    const rect = mark.getBoundingClientRect();
    setTip({
      label: label ?? '',
      value,
      x: rect.left + rect.width / 2 - box.left,
      y: rect.top - box.top,
    });
  }, []);

  return (
    <div ref={host} className="relative" onPointerMove={onMove} onPointerLeave={() => setTip(null)}>
      {children}
      {tip && (
        <div
          className="pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-full rounded-md border border-border bg-surface px-2.5 py-1.5 whitespace-nowrap shadow-lg"
          style={{ left: tip.x, top: tip.y - 6 }}
          role="status"
        >
          <span className="block font-mono text-[10px] uppercase tracking-widest text-text-3">
            {tip.label}
          </span>
          <span className="font-mono text-xs font-semibold text-text">{tip.value}</span>
        </div>
      )}
    </div>
  );
}
