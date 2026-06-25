import type { ReactNode } from 'react';

import { AdminNav } from '@/components/AdminNav';
import { requireOrgAdmin } from '@/lib/roles';

export default async function AdminLayout({ children }: { children: ReactNode }) {
  await requireOrgAdmin();
  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <AdminNav />
      {children}
    </div>
  );
}
