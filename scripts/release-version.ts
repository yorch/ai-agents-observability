import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const versionPattern = /^\d+\.\d+\.\d+$/;

export function releaseManifestPaths(): string[] {
  const rootManifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
    workspaces?: string[] | { packages?: string[] };
  };
  const patterns = Array.isArray(rootManifest.workspaces)
    ? rootManifest.workspaces
    : rootManifest.workspaces?.packages;
  if (!patterns || patterns.length === 0) {
    throw new Error('Root package.json does not declare any workspaces');
  }

  const paths = new Set<string>(['package.json']);
  for (const pattern of patterns) {
    const manifests = [
      ...new Bun.Glob(`${pattern.replace(/\/$/, '')}/package.json`).scanSync({
        cwd: root,
        onlyFiles: true,
      }),
    ];
    if (manifests.length === 0) {
      throw new Error(`Workspace pattern has no manifests: ${pattern}`);
    }
    for (const path of manifests) {
      paths.add(path);
    }
  }
  return [...paths].sort();
}

export function assertReleaseVersion(version: string): void {
  if (!versionPattern.test(version)) {
    throw new Error(`Expected a stable semantic version (X.Y.Z), got: ${version}`);
  }
}

async function readManifest(path: string): Promise<Record<string, unknown>> {
  return Bun.file(resolve(root, path)).json();
}

async function setVersions(version: string): Promise<void> {
  for (const path of releaseManifestPaths()) {
    const manifest = await readManifest(path);
    manifest.version = version;
    await Bun.write(resolve(root, path), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`${path}: ${version}`);
  }
}

async function checkVersions(version: string): Promise<void> {
  const mismatches: string[] = [];
  for (const path of releaseManifestPaths()) {
    const manifest = await readManifest(path);
    if (manifest.version !== version) {
      mismatches.push(`${path}: ${String(manifest.version)}`);
    }
  }

  if (mismatches.length > 0) {
    throw new Error(`Expected every package version to be ${version}:\n${mismatches.join('\n')}`);
  }

  console.log(`All ${releaseManifestPaths().length} package manifests are version ${version}.`);
}

if (import.meta.main) {
  const [command, version] = Bun.argv.slice(2);
  if (command === 'list') {
    console.log(releaseManifestPaths().join('\n'));
  } else {
    if ((command !== 'set' && command !== 'check') || !version) {
      throw new Error('Usage: bun scripts/release-version.ts list | <set|check> X.Y.Z');
    }
    assertReleaseVersion(version);
    await (command === 'set' ? setVersions(version) : checkVersions(version));
  }
}
