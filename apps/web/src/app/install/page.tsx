import Link from 'next/link';
import { ArrowLeftIcon, CheckIcon } from '@/components/icons';

export default function InstallPage() {
  const targets = [
    { arch: 'arm64', binary: 'claude-telemetry-darwin-arm64', os: 'macOS (Apple Silicon)' },
    { arch: 'x64', binary: 'claude-telemetry-darwin-x64', os: 'macOS (Intel)' },
    { arch: 'arm64', binary: 'claude-telemetry-linux-arm64', os: 'Linux (ARM64)' },
    { arch: 'x64', binary: 'claude-telemetry-linux-x64', os: 'Linux (x86-64)' },
  ];

  return (
    <div className="mx-auto max-w-2xl px-4 py-12 space-y-10">
      <div>
        <Link
          href="/me"
          className="inline-flex items-center gap-1 text-sm text-white/50 hover:text-white"
        >
          <ArrowLeftIcon /> Back
        </Link>
      </div>

      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">Install the telemetry hook</h1>
        <p className="text-sm text-white/50">
          The hook is a lightweight CLI that runs on your machine alongside Claude Code, capturing
          session events and shipping them to this dashboard.
        </p>
      </div>

      {/* Step 1 — Download */}
      <section className="space-y-4">
        <div className="flex items-center gap-3">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand-500/20 text-xs font-semibold text-brand-400 border border-brand-500/30">
            1
          </span>
          <h2 className="text-base font-medium">Download the binary</h2>
        </div>

        <p className="text-sm text-white/60">
          Pick the binary for your platform from the{' '}
          <a
            href="https://github.com/ai-agents-observability/releases/latest"
            className="text-brand-400 hover:underline"
            target="_blank"
            rel="noopener noreferrer"
          >
            GitHub releases page
          </a>
          :
        </p>

        <div className="rounded-lg border border-white/10 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 text-xs text-white/40">
                <th className="text-left px-4 py-2">Platform</th>
                <th className="text-left px-4 py-2">Binary name</th>
              </tr>
            </thead>
            <tbody>
              {targets.map((t) => (
                <tr key={t.binary} className="border-b border-white/5 last:border-0">
                  <td className="px-4 py-2.5 text-white/70">{t.os}</td>
                  <td className="px-4 py-2.5 font-mono text-xs text-white/60">{t.binary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="text-sm text-white/50">Then make it executable:</p>
        <pre className="rounded-md bg-black/30 px-4 py-3 text-sm font-mono text-white/80 overflow-x-auto">
          {`chmod +x claude-telemetry-<os>-<arch>
sudo mv claude-telemetry-<os>-<arch> /usr/local/bin/claude-telemetry`}
        </pre>
      </section>

      {/* Step 2 — Install hooks */}
      <section className="space-y-4">
        <div className="flex items-center gap-3">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand-500/20 text-xs font-semibold text-brand-400 border border-brand-500/30">
            2
          </span>
          <h2 className="text-base font-medium">Install Claude Code hooks</h2>
        </div>

        <p className="text-sm text-white/60">
          Run the install command. This registers the hook with Claude Code so it fires
          automatically for every session:
        </p>
        <pre className="rounded-md bg-black/30 px-4 py-3 text-sm font-mono text-white/80 overflow-x-auto">
          claude-telemetry install
        </pre>
      </section>

      {/* Step 3 — Log in */}
      <section className="space-y-4">
        <div className="flex items-center gap-3">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand-500/20 text-xs font-semibold text-brand-400 border border-brand-500/30">
            3
          </span>
          <h2 className="text-base font-medium">Authenticate</h2>
        </div>

        <p className="text-sm text-white/60">
          Link the hook to your account so telemetry is routed to your dashboard:
        </p>
        <pre className="rounded-md bg-black/30 px-4 py-3 text-sm font-mono text-white/80 overflow-x-auto">
          claude-telemetry login
        </pre>
        <p className="text-xs text-white/40">
          This opens a browser window to complete the OAuth flow. Your auth token is stored locally
          in <code className="font-mono">~/.claude-telemetry/config.json</code>.
        </p>
      </section>

      {/* Verify */}
      <section className="space-y-4">
        <div className="flex items-center gap-3">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white/5 text-white/40 border border-white/10">
            <CheckIcon size={12} />
          </span>
          <h2 className="text-base font-medium text-white/60">Verify</h2>
        </div>
        <p className="text-sm text-white/50">
          Start a Claude Code session. After it ends, refresh your{' '}
          <Link href="/me" className="text-brand-400 hover:underline">
            My Agents
          </Link>{' '}
          page — you should see the session appear within a few seconds.
        </p>
      </section>

      {/* Pause / uninstall */}
      <section className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-3">
        <h2 className="text-sm font-medium text-white/60">Other commands</h2>
        <div className="space-y-2 text-sm">
          <div>
            <code className="font-mono text-xs text-white/70">claude-telemetry pause</code>
            <span className="ml-3 text-white/40">— temporarily stop sending telemetry</span>
          </div>
          <div>
            <code className="font-mono text-xs text-white/70">claude-telemetry resume</code>
            <span className="ml-3 text-white/40">— re-enable telemetry</span>
          </div>
          <div>
            <code className="font-mono text-xs text-white/70">claude-telemetry uninstall</code>
            <span className="ml-3 text-white/40">— remove hooks from Claude Code</span>
          </div>
        </div>
        <p className="text-xs text-white/30">
          You can also manage privacy settings from the{' '}
          <Link href="/me/privacy" className="text-brand-400 hover:underline">
            Privacy
          </Link>{' '}
          page.
        </p>
      </section>
    </div>
  );
}
