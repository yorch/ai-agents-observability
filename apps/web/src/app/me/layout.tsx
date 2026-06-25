import { MeNav } from '@/components/me/MeNav';

export default function MeLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <MeNav />
      {children}
    </div>
  );
}
