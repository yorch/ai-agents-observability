import { getConfig } from '@/lib/config';
import { sanitizeNext } from '@/lib/session-cookie';

import { PasswordForm } from './password-form';

export const dynamic = 'force-dynamic';

type Props = {
  searchParams: Promise<{ next?: string }>;
};

export default async function LoginPage({ searchParams }: Props) {
  const { githubHost } = getConfig();
  const params = await searchParams;
  const next = sanitizeNext(params.next);
  const signInHref = next ? `/api/auth/login?next=${encodeURIComponent(next)}` : '/api/auth/login';

  return (
    <div className="flex min-h-[calc(100vh-4rem)] items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-8">
        <div className="text-center space-y-2">
          <h1 className="font-display text-2xl font-semibold tracking-tight text-text">
            ai-agents-observability
          </h1>
          <p className="text-sm text-text-2">Personal telemetry for your Claude Code sessions.</p>
        </div>

        <div className="space-y-4">
          <a
            href={signInHref}
            className="flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-bg transition-opacity hover:opacity-90"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="currentColor"
              role="img"
              aria-label="GitHub"
            >
              <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0 1 12 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z" />
            </svg>
            Sign in with GitHub
          </a>
          <p className="text-center text-xs text-text-3">via {githubHost}</p>
        </div>

        <div className="relative">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-border" />
          </div>
          <div className="relative flex justify-center text-xs text-text-3">
            <span className="bg-bg px-3">or</span>
          </div>
        </div>

        <PasswordForm {...(next ? { next } : {})} />
      </div>
    </div>
  );
}
