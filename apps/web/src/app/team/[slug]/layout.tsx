import Link from 'next/link';

export default function TeamLayout({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-6xl px-4 py-8">{children}</div>;
}

export function TeamSubNav({ slug, active }: { active: 'overview' | 'roster' | 'prs'; slug: string }) {
  const linkClass = (tab: string) =>
    `text-sm pb-3 transition-colors ${active === tab ? 'text-white border-b-2 border-brand-500' : 'text-white/50 hover:text-white/80'}`;

  return (
    <nav className="mb-6 flex gap-6 border-b border-white/10">
      <Link href={`/team/${slug}`} className={linkClass('overview')}>
        Overview
      </Link>
      <Link href={`/team/${slug}/roster`} className={linkClass('roster')}>
        Roster
      </Link>
      <Link href={`/team/${slug}/prs`} className={linkClass('prs')}>
        PRs
      </Link>
    </nav>
  );
}
