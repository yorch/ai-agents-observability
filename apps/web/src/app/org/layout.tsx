import type { ReactNode } from 'react';
import { OrgSubNav } from './_sub-nav';

export default function OrgLayout({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto max-w-7xl px-4 py-8">
      <OrgSubNav />
      {children}
    </div>
  );
}
