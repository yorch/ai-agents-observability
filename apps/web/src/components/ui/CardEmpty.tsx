import type { ReactNode } from 'react';

/** The in-card empty state: a quiet centered line, never a nested EmptyState card. */
export function CardEmpty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-text-3">{children}</p>;
}
