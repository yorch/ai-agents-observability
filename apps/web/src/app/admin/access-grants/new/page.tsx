import { redirect } from 'next/navigation';

import { requireGrantRequester } from '@/lib/roles';

export const dynamic = 'force-dynamic';

// The request form lives at /me/grants/new so investigators (who cannot enter
// /admin) can reach it; this path stays for existing admin links.
export default async function NewAccessGrantPage() {
  await requireGrantRequester();
  redirect('/me/grants/new');
}
