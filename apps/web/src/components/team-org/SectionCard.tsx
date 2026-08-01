import type { ReactNode } from 'react';

export function SectionCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-lg border border-border bg-surface p-4${className ? ` ${className}` : ''}`}
    >
      {children}
    </div>
  );
}
