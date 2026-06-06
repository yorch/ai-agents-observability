import Link from 'next/link';

export default function TeamLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  // params is a Promise in Next.js 16 — resolve in page components, not layout.
  // The layout renders the shell; individual pages gate with requireTeamLead().
  void params;

  return <div className="mx-auto max-w-6xl px-4 py-8">{children}</div>;
}

export function TeamSubNav({ slug, active }: { active: 'overview' | 'roster'; slug: string }) {
  const linkClass = (tab: string) =>
    `text-sm transition-colors ${active === tab ? 'text-white border-b-2 border-brand-500 pb-3' : 'text-white/50 hover:text-white/80 pb-3'}`;

  return (
    <nav className="mb-6 flex gap-6 border-b border-white/10">
      <Link href={`/team/${slug}`} className={linkClass('overview')}>
        Overview
      </Link>
      <Link href={`/team/${slug}/roster`} className={linkClass('roster')}>
        Roster
      </Link>
    </nav>
  );
}
