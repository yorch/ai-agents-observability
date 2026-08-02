import type { ReactNode } from 'react';

/**
 * The card surface as a `<form method="GET">`, for faceted filter panels.
 *
 * `Card` renders a `div` and so cannot be one; rather than each filter page
 * hand-copying the surface, this is the one place it lives. Put the fields in a
 * `grid` and the actions in a bordered footer row — see `/org/search`.
 */
export function FilterPanel({ children, label }: { children: ReactNode; label: string }) {
  return (
    <form
      method="GET"
      aria-label={label}
      className="space-y-4 rounded-lg border border-border bg-surface p-4"
    >
      {children}
    </form>
  );
}
