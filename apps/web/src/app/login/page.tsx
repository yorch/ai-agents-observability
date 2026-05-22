import { sanitizeNext } from '../../lib/session-cookie';

export const dynamic = 'force-dynamic';

type Props = {
  searchParams: Promise<{ next?: string }>;
};

export default async function LoginPage({ searchParams }: Props) {
  const githubHost = process.env.GITHUB_HOST ?? 'github.com';
  const params = await searchParams;
  const next = sanitizeNext(params.next);
  const signInHref = next ? `/api/auth/login?next=${encodeURIComponent(next)}` : '/api/auth/login';

  return (
    <div className="mx-auto max-w-md space-y-6 py-16 text-center">
      <h1 className="font-display text-3xl font-semibold tracking-tight">
        ai-agents-observability
      </h1>
      <p className="text-sm text-white/70">
        Personal telemetry for your Claude Code sessions. Sign in to see what's collected about you
        — and nothing about anyone else.
      </p>
      <a
        href={signInHref}
        className="inline-flex items-center justify-center rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow hover:bg-brand-500"
      >
        Sign in with GitHub
      </a>
      <p className="text-xs text-white/50">Signing in via {githubHost}</p>
    </div>
  );
}
