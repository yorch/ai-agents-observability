import Link from 'next/link';
import { ArrowLeftIcon, CheckIcon } from '@/components/icons';
import { Card } from '@/components/ui';

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
          className="inline-flex items-center gap-1 text-sm text-text-2 hover:text-text"
        >
          <ArrowLeftIcon /> Back
        </Link>
      </div>

      <div className="space-y-2">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-text">
          Install the telemetry hook
        </h1>
        <p className="text-sm text-text-2">
          The hook is a lightweight CLI that runs on your machine alongside Claude Code, capturing
          session events and shipping them to this dashboard.
        </p>
      </div>

      {/* Step 1 — Download */}
      <section className="space-y-4">
        <div className="flex items-center gap-3">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent border border-accent-line">
            1
          </span>
          <h2 className="text-base font-medium">Download the binary</h2>
        </div>

        <p className="text-sm text-text-2">
          Pick the binary for your platform from the{' '}
          <a
            href="https://github.com/ai-agents-observability/releases/latest"
            className="text-accent hover:underline"
            target="_blank"
            rel="noopener noreferrer"
          >
            GitHub releases page
          </a>
          :
        </p>

        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-xs text-text-3">
                <th className="text-left px-4 py-2">Platform</th>
                <th className="text-left px-4 py-2">Binary name</th>
              </tr>
            </thead>
            <tbody>
              {targets.map((t) => (
                <tr key={t.binary} className="border-b border-border-subtle last:border-0">
                  <td className="px-4 py-2.5 text-text-2">{t.os}</td>
                  <td className="px-4 py-2.5 font-mono text-xs text-text-2">{t.binary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="text-sm text-text-2">Then make it executable:</p>
        <pre className="rounded-md bg-surface-2 px-4 py-3 text-sm font-mono text-text overflow-x-auto">
          {`chmod +x claude-telemetry-<os>-<arch>
sudo mv claude-telemetry-<os>-<arch> /usr/local/bin/claude-telemetry`}
        </pre>
      </section>

      {/* Step 2 — Install hooks */}
      <section className="space-y-4">
        <div className="flex items-center gap-3">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent border border-accent-line">
            2
          </span>
          <h2 className="text-base font-medium">Install Claude Code hooks</h2>
        </div>

        <p className="text-sm text-text-2">
          Run the install command. This registers the hook with Claude Code so it fires
          automatically for every session:
        </p>
        <pre className="rounded-md bg-surface-2 px-4 py-3 text-sm font-mono text-text overflow-x-auto">
          claude-telemetry install
        </pre>
      </section>

      {/* Step 3 — Log in */}
      <section className="space-y-4">
        <div className="flex items-center gap-3">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent border border-accent-line">
            3
          </span>
          <h2 className="text-base font-medium">Authenticate</h2>
        </div>

        <p className="text-sm text-text-2">
          Link the hook to your account so telemetry is routed to your dashboard:
        </p>
        <pre className="rounded-md bg-surface-2 px-4 py-3 text-sm font-mono text-text overflow-x-auto">
          claude-telemetry login
        </pre>
        <p className="text-xs text-text-3">
          This opens a browser window to complete the OAuth flow. Your auth token is stored locally
          in <code className="font-mono">~/.claude-telemetry/config.json</code>.
        </p>
      </section>

      {/* Verify */}
      <section className="space-y-4">
        <div className="flex items-center gap-3">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-surface text-text-3 border border-border">
            <CheckIcon size={12} />
          </span>
          <h2 className="text-base font-medium text-text-2">Verify</h2>
        </div>
        <p className="text-sm text-text-2">
          Start a Claude Code session. After it ends, refresh your{' '}
          <Link href="/me" className="text-accent hover:underline">
            My Agents
          </Link>{' '}
          page — you should see the session appear within a few seconds.
        </p>
      </section>

      {/* Pause / uninstall */}
      <Card className="space-y-3">
        <h2 className="text-sm font-medium text-text-2">Other commands</h2>
        <div className="space-y-2 text-sm">
          <div>
            <code className="font-mono text-xs text-text-2">claude-telemetry pause</code>
            <span className="ml-3 text-text-3">— temporarily stop sending telemetry</span>
          </div>
          <div>
            <code className="font-mono text-xs text-text-2">claude-telemetry resume</code>
            <span className="ml-3 text-text-3">— re-enable telemetry</span>
          </div>
          <div>
            <code className="font-mono text-xs text-text-2">claude-telemetry uninstall</code>
            <span className="ml-3 text-text-3">— remove hooks from Claude Code</span>
          </div>
        </div>
        <p className="text-xs text-text-3">
          You can also manage privacy settings from the{' '}
          <Link href="/me/privacy" className="text-accent hover:underline">
            Privacy
          </Link>{' '}
          page.
        </p>
      </Card>
    </div>
  );
}
