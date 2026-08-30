import { type AgentTypeKey, agentDisplayName } from '@ai-agents-observability/schemas';
import Link from 'next/link';
import { ArrowLeftIcon, CheckIcon } from '@/components/icons';
import { Card, Cell, Row, Table } from '@/components/ui';
import { Segmented, SegmentedLink } from '@/components/ui/Segmented';

/**
 * Adapter-specific info not in the agent registry: the `--agent` CLI flag, where
 * the config snippet goes, and whether `import` supports this agent. Labels come
 * from `agentDisplayName()` so they never drift from `AGENT_REGISTRY`.
 */
const AGENT_INFO: {
  configPath: string;
  flag: string;
  importable: boolean;
  type: AgentTypeKey;
}[] = [
  {
    configPath: '~/.claude/settings.json',
    flag: 'claude-code',
    importable: true,
    type: 'CLAUDE_CODE',
  },
  { configPath: '~/.codex/hooks.json', flag: 'codex', importable: true, type: 'CODEX' },
  {
    configPath: '~/.gemini/settings.json',
    flag: 'gemini-cli',
    importable: false,
    type: 'GEMINI_CLI',
  },
  { configPath: '~/.copilot/hooks/', flag: 'copilot', importable: false, type: 'COPILOT' },
  { configPath: '~/.pi/agent/extensions/', flag: 'pi', importable: true, type: 'PI' },
  { configPath: '~/.omp/agent/hooks/', flag: 'omp', importable: true, type: 'OMP' },
  {
    configPath: '~/.config/opencode/plugin/',
    flag: 'opencode',
    importable: true,
    type: 'OPENCODE',
  },
];

const REPO_URL = 'https://github.com/yorch/ai-agents-observability';

export default async function InstallPage({
  searchParams,
}: {
  searchParams: Promise<{ agent?: string }>;
}) {
  const { agent: selectedFlag } = await searchParams;
  const fallback = AGENT_INFO[0];
  const selected = AGENT_INFO.find((a) => a.flag === selectedFlag) ?? fallback;
  if (!selected) {
    return null;
  }

  const targets = [
    {
      launcher: 'aiot-darwin-arm64',
      os: 'macOS (Apple Silicon)',
      runtime: 'aiot-runtime-darwin-arm64',
    },
    { launcher: 'aiot-darwin-x64', os: 'macOS (Intel)', runtime: 'aiot-runtime-darwin-x64' },
    { launcher: 'aiot-linux-arm64', os: 'Linux (ARM64)', runtime: 'aiot-runtime-linux-arm64' },
    { launcher: 'aiot-linux-x64', os: 'Linux (x86-64)', runtime: 'aiot-runtime-linux-x64' },
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
          The hook is a lightweight CLI that runs on your machine alongside your AI coding agent,
          capturing session events and shipping them to this dashboard. It supports{' '}
          {AGENT_INFO.map((a, i) => (
            <span key={a.flag}>
              {i > 0 && ', '}
              {agentDisplayName(a.type)}
            </span>
          ))}
          .
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
            href={`${REPO_URL}/releases/latest`}
            className="text-accent hover:underline"
            target="_blank"
            rel="noopener noreferrer"
          >
            GitHub releases page
          </a>
          , or use the installer script:
        </p>

        <pre className="rounded-md bg-surface-2 px-4 py-3 text-sm font-mono text-text overflow-x-auto">
          {`curl -fsSL ${REPO_URL}/raw/main/scripts/install.sh | bash`}
        </pre>

        <Card flush>
          <Table columns={[{ label: 'Platform' }, { label: 'Launcher' }, { label: 'Runtime' }]}>
            {targets.map((t) => (
              <Row key={t.launcher}>
                <Cell className="text-text-2">{t.os}</Cell>
                <Cell className="text-xs text-text-2">{t.launcher}</Cell>
                <Cell className="text-xs text-text-2">{t.runtime}</Cell>
              </Row>
            ))}
          </Table>
        </Card>

        <p className="text-sm text-text-2">
          Then make both executable and install them to the same directory:
        </p>
        <pre className="rounded-md bg-surface-2 px-4 py-3 text-sm font-mono text-text overflow-x-auto">
          {`chmod +x aiot-<os>-<arch> aiot-runtime-<os>-<arch>
sudo mv aiot-<os>-<arch> /usr/local/bin/aiot
sudo mv aiot-runtime-<os>-<arch> /usr/local/bin/aiot-runtime`}
        </pre>
      </section>

      {/* Step 2 — Configure & authenticate */}
      <section className="space-y-4">
        <div className="flex items-center gap-3">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent border border-accent-line">
            2
          </span>
          <h2 className="text-base font-medium">Configure and authenticate</h2>
        </div>

        <p className="text-sm text-text-2">
          If the server is not on localhost, point the hook at it, then log in:
        </p>
        <pre className="rounded-md bg-surface-2 px-4 py-3 text-sm font-mono text-text overflow-x-auto">
          {`aiot config set web-url https://observability.example.com
aiot config set ingest-url https://ingest.example.com
aiot login`}
        </pre>
        <p className="text-xs text-text-3">
          This prints a URL and a short device code — open the URL in your browser and enter the
          code to authorize. Your auth token is stored locally in{' '}
          <code className="font-mono">~/.aiot/identity.json</code>.
        </p>
      </section>

      {/* Step 3 — Install hooks for your agent */}
      <section className="space-y-4">
        <div className="flex items-center gap-3">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent border border-accent-line">
            3
          </span>
          <h2 className="text-base font-medium">Install hooks for your agent</h2>
        </div>

        <p className="text-sm text-text-2">
          Select your agent to see the install command. The hook writes background service files and
          prints the config snippet to paste into your agent&apos;s settings.
        </p>

        <div className="overflow-x-auto">
          <Segmented label="Agent">
            {AGENT_INFO.map((a) => (
              <SegmentedLink
                key={a.flag}
                href={`/install?agent=${a.flag}`}
                selected={a.flag === selected.flag}
              >
                {agentDisplayName(a.type)}
              </SegmentedLink>
            ))}
          </Segmented>
        </div>

        <pre className="rounded-md bg-surface-2 px-4 py-3 text-sm font-mono text-text overflow-x-auto">
          {selected.flag === 'claude-code'
            ? 'aiot install'
            : `aiot install --agent ${selected.flag}`}
        </pre>

        <p className="text-sm text-text-2">
          The command prints a config snippet to paste into{' '}
          <code className="font-mono text-xs">{selected.configPath}</code>. For the exact snippet
          for each agent, see the{' '}
          <a
            href={`${REPO_URL}/blob/main/docs/getting-started.md`}
            className="text-accent hover:underline"
            target="_blank"
            rel="noopener noreferrer"
          >
            Getting Started guide
          </a>
          .
        </p>
      </section>

      {/* Step 4 — Import existing data (only for agents that support it) */}
      {selected.importable && (
        <section className="space-y-4">
          <div className="flex items-center gap-3">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent border border-accent-line">
              4
            </span>
            <h2 className="text-base font-medium">Import existing sessions (optional)</h2>
          </div>

          <p className="text-sm text-text-2">
            If you have historical sessions from before the hook was installed, backfill them:
          </p>
          <pre className="rounded-md bg-surface-2 px-4 py-3 text-sm font-mono text-text overflow-x-auto">
            {`aiot import --dry-run
aiot import --agent ${selected.flag} --since 2026-01-01`}
          </pre>
          <p className="text-xs text-text-3">
            Imports are safe to re-run — the server deduplicates by event ID. Import is not
            available for all agents; see the Getting Started guide for details.
          </p>
        </section>
      )}

      {/* Verify */}
      <section className="space-y-4">
        <div className="flex items-center gap-3">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-surface text-text-3 border border-border">
            <CheckIcon size={12} />
          </span>
          <h2 className="text-base font-medium text-text-2">Verify</h2>
        </div>
        <p className="text-sm text-text-2">
          Run <code className="font-mono text-xs">aiot status</code> to check everything is healthy.
          Then start a session in your agent. After it ends, refresh your{' '}
          <Link href="/me" className="text-accent hover:underline">
            My Agents
          </Link>{' '}
          page — you should see the session appear within a few seconds.
        </p>
      </section>

      {/* Pause / uninstall */}
      <Card title="Other commands" contentClassName="space-y-3">
        <div className="space-y-2 text-sm">
          <div>
            <code className="font-mono text-xs text-text-2">aiot pause</code>
            <span className="ml-3 text-text-3">— temporarily stop sending telemetry</span>
          </div>
          <div>
            <code className="font-mono text-xs text-text-2">aiot resume</code>
            <span className="ml-3 text-text-3">— re-enable telemetry</span>
          </div>
          <div>
            <code className="font-mono text-xs text-text-2">aiot uninstall</code>
            <span className="ml-3 text-text-3">— remove hooks and background services</span>
          </div>
        </div>
        <p className="text-xs text-text-3">
          You can also manage privacy settings from the{' '}
          <Link href="/me/settings/privacy" className="text-accent hover:underline">
            Privacy
          </Link>{' '}
          page.
        </p>
      </Card>
    </div>
  );
}
