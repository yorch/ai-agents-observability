export default function MeLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <nav className="mb-6 flex gap-4 border-b border-white/10 pb-4 text-sm">
        <a href="/me" className="text-white/70 hover:text-white">
          Overview
        </a>
        <a href="/me/sessions" className="text-white/70 hover:text-white">
          Sessions
        </a>
        <a href="/me/prs" className="text-white/70 hover:text-white">
          Pull Requests
        </a>
        <a href="/me/privacy" className="text-white/70 hover:text-white">
          Privacy
        </a>
        <a href="/me/audit" className="text-white/70 hover:text-white">
          Audit log
        </a>
      </nav>
      {children}
    </div>
  );
}
