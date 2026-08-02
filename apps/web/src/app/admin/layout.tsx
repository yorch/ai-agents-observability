import type { ReactNode } from 'react';

import { requireOrgAdmin } from '@/lib/roles';

// Admin navigation lives in the rail; the root layout owns the content measure.
// The gate stays here — it is the only thing this layout is responsible for.
export default async function AdminLayout({ children }: { children: ReactNode }) {
  await requireOrgAdmin();
  return children;
}
