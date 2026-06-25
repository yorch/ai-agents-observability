import type { ReactNode } from 'react';

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-10 text-center text-sm text-white/40">
      {children}
    </div>
  );
}
