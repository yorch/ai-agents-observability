import Link from 'next/link';
import { ArrowLeftIcon, CheckIcon } from '@/components/icons';
import { Card, Cell, Row, Table } from '@/components/ui';
import { format } from '@/i18n/config';
import { getTranslations } from '@/i18n/server';

export default async function InstallPage() {
  const { dict } = await getTranslations();
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
          <ArrowLeftIcon /> {dict.common.back}
        </Link>
      </div>

      <div className="space-y-2">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-text">
          {dict.install.title}
        </h1>
        <p className="text-sm text-text-2">{dict.install.description}</p>
      </div>

      {/* Step 1 — Download */}
      <section className="space-y-4">
        <div className="flex items-center gap-3">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent border border-accent-line">
            1
          </span>
          <h2 className="text-base font-medium">{dict.install.step1}</h2>
        </div>

        <p className="text-sm text-text-2">
          {dict.install.step1PickBinaryPrefix}{' '}
          <a
            href="https://github.com/ai-agents-observability/releases/latest"
            className="text-accent hover:underline"
            target="_blank"
            rel="noopener noreferrer"
          >
            {dict.install.step1ReleasesLink}
          </a>
          {dict.install.step1PickBinarySuffix}
        </p>

        <div className="rounded-lg border border-border overflow-hidden">
          <Table
            columns={[
              { label: dict.install.tablePlatform },
              { label: dict.install.tableBinaryName },
            ]}
          >
            {targets.map((t) => (
              <Row key={t.binary}>
                <Cell className="text-text-2">{t.os}</Cell>
                <Cell className="text-xs text-text-2">{t.binary}</Cell>
              </Row>
            ))}
          </Table>
        </div>

        <p className="text-sm text-text-2">{dict.install.step1MakeExecutable}</p>
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
          <h2 className="text-base font-medium">{dict.install.step2}</h2>
        </div>

        <p className="text-sm text-text-2">{dict.install.step2Description}</p>
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
          <h2 className="text-base font-medium">{dict.install.step3}</h2>
        </div>

        <p className="text-sm text-text-2">{dict.install.step3Description}</p>
        <pre className="rounded-md bg-surface-2 px-4 py-3 text-sm font-mono text-text overflow-x-auto">
          claude-telemetry login
        </pre>
        <p className="text-xs text-text-3">
          {format(dict.install.step3Note, { path: '~/.claude-telemetry/config.json' })}
        </p>
      </section>

      {/* Verify */}
      <section className="space-y-4">
        <div className="flex items-center gap-3">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-surface text-text-3 border border-border">
            <CheckIcon size={12} />
          </span>
          <h2 className="text-base font-medium text-text-2">{dict.install.verify}</h2>
        </div>
        <p className="text-sm text-text-2">
          {dict.install.verifyDescriptionPrefix}{' '}
          <Link href="/me" className="text-accent hover:underline">
            {dict.install.verifyMyAgentsLink}
          </Link>{' '}
          {dict.install.verifyDescriptionSuffix}
        </p>
      </section>

      {/* Pause / uninstall */}
      <Card contentClassName="space-y-3">
        <h2 className="text-sm font-medium text-text-2">{dict.install.otherCommands}</h2>
        <div className="space-y-2 text-sm">
          <div>
            <code className="font-mono text-xs text-text-2">claude-telemetry pause</code>
            <span className="ml-3 text-text-3">{dict.install.pauseDescription}</span>
          </div>
          <div>
            <code className="font-mono text-xs text-text-2">claude-telemetry resume</code>
            <span className="ml-3 text-text-3">{dict.install.resumeDescription}</span>
          </div>
          <div>
            <code className="font-mono text-xs text-text-2">claude-telemetry uninstall</code>
            <span className="ml-3 text-text-3">{dict.install.uninstallDescription}</span>
          </div>
        </div>
        <p className="text-xs text-text-3">
          {dict.install.privacyNotePrefix}{' '}
          <Link href="/me/settings/privacy" className="text-accent hover:underline">
            {dict.install.privacyLink}
          </Link>{' '}
          {dict.install.privacyNoteSuffix}
        </p>
      </Card>
    </div>
  );
}
