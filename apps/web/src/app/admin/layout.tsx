import type { ReactNode } from 'react';

import { requireOrgAdmin } from '@/lib/roles';

export default async function AdminLayout({ children }: { children: ReactNode }) {
  await requireOrgAdmin();
  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <nav className="flex gap-4 mb-6 text-sm">
        <a href="/admin/jobs" className="text-brand-400 hover:underline">
          Jobs
        </a>
      </nav>
      {children}
    </div>
  );
}
