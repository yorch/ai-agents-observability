import type { ReactNode } from 'react';

// "My agents" navigation lives in the rail; the root layout owns the measure.
export default function MeLayout({ children }: { children: ReactNode }) {
  return children;
}
