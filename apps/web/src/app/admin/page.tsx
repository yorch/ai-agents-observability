import { redirect } from 'next/navigation';

import { ADMIN_NAV } from '@/components/shell/nav-model';

// The ADMIN scope opens the first page the rail lists, so the landing page is
// the highlighted item rather than one picked separately here.
export default function AdminRootPage() {
  redirect(ADMIN_NAV[0]?.items[0]?.href ?? '/admin/jobs');
}
