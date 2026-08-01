import type { ReactNode } from 'react';

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-10 text-center text-sm text-text-3">
      {children}
    </div>
  );
}
