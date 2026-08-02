import type { ReactNode } from 'react';

// Org navigation lives in the rail; the root layout owns the content measure.
export default function OrgLayout({ children }: { children: ReactNode }) {
  return children;
}
