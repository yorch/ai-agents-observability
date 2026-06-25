import type { ReactNode } from 'react';

export function SectionCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-lg border border-white/10 bg-white/5 p-4${className ? ` ${className}` : ''}`}
    >
      {children}
    </div>
  );
}
