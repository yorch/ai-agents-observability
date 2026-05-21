import { redirect } from 'next/navigation';

import { currentUser } from '../lib/auth.js';

export default async function HomePage() {
  const user = await currentUser();
  redirect(user ? '/me' : '/login');
}
