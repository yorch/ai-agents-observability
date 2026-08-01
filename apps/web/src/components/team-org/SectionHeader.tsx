import type { ReactNode } from 'react';

export function SectionHeader({ children }: { children: ReactNode }) {
  return <h3 className="mb-3 text-xs uppercase tracking-widest text-text-3">{children}</h3>;
}
