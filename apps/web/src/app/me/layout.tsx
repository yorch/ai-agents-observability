import { MeNav } from '@/components/me/MeNav';
import { currentUser } from '@/lib/auth';
import { canRequestGrants } from '@/lib/roles';

export default async function MeLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  const showGrants = user ? canRequestGrants(user.orgRole) : false;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <MeNav showGrants={showGrants} />
      {children}
    </div>
  );
}
