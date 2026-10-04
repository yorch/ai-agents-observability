/**
 * Verifies an S3-to-S3 object copy by diffing two `rclone lsjson -R -M` dumps.
 *
 * Why this and not `rclone check`: `rclone check` (with or without --download)
 * compares bytes and sizes, and reports "0 differences" on a copy that lost
 * every piece of user metadata. The metadata is load-bearing here: the
 * transcript upload stores its sha256 as `upload-sha256` user metadata and the
 * ingest idempotency check reads it back. A copy that dropped it would not lose
 * data, but it would silently re-ship and re-process every transcript.
 *
 * Every object on the source must exist on the destination with the same size
 * and the same metadata. rclone stamps `mtime` / `btime` / `atime` itself, so
 * those three are ignored; every other key must match exactly.
 *
 * Usage: bun run scripts/verify-object-copy.ts <source.json> <destination.json>
 * Exit 0 = identical, 1 = differences (or unreadable input).
 */

export interface LsjsonEntry {
  IsDir?: boolean;
  Metadata?: Record<string, string>;
  Path: string;
  Size: number;
}

export interface CopyReport {
  /** Objects whose size or metadata differ, with a human-readable reason. */
  mismatched: { path: string; reason: string }[];
  /** Objects present on the source but not the destination. */
  missing: string[];
  /** Objects per top-level prefix (`transcripts/`, `judge-rationales/`, ...). */
  prefixCounts: { destination: Record<string, number>; source: Record<string, number> };
  /** Objects carrying `upload-sha256` on each side. */
  sha256Counts: { destination: number; source: number };
}

const RCLONE_STAMPED = new Set(['mtime', 'btime', 'atime']);
export const SHA256_KEY = 'upload-sha256';

function objectsOf(entries: LsjsonEntry[]): Map<string, LsjsonEntry> {
  return new Map(entries.filter((e) => !e.IsDir).map((e) => [e.Path, e]));
}

function prefixOf(path: string): string {
  const slash = path.indexOf('/');
  return slash === -1 ? '(root)' : `${path.slice(0, slash)}/`;
}

function countPrefixes(objects: Map<string, LsjsonEntry>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const path of objects.keys()) {
    const prefix = prefixOf(path);
    out[prefix] = (out[prefix] ?? 0) + 1;
  }
  return out;
}

function withoutStamped(meta: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(meta ?? {}).filter(([k]) => !RCLONE_STAMPED.has(k)));
}

function countSha256(objects: Map<string, LsjsonEntry>): number {
  let n = 0;
  for (const o of objects.values()) {
    if (o.Metadata?.[SHA256_KEY]) {
      n++;
    }
  }
  return n;
}

export function diffObjectCopy(source: LsjsonEntry[], destination: LsjsonEntry[]): CopyReport {
  const src = objectsOf(source);
  const dst = objectsOf(destination);
  const missing: string[] = [];
  const mismatched: { path: string; reason: string }[] = [];

  for (const [path, s] of src) {
    const d = dst.get(path);
    if (!d) {
      missing.push(path);
      continue;
    }
    if (s.Size !== d.Size) {
      mismatched.push({ path, reason: `size ${s.Size} != ${d.Size}` });
      continue;
    }
    const sm = withoutStamped(s.Metadata);
    const dm = withoutStamped(d.Metadata);
    const keys = new Set([...Object.keys(sm), ...Object.keys(dm)]);
    for (const key of [...keys].sort()) {
      if (sm[key] !== dm[key]) {
        mismatched.push({
          path,
          reason: `metadata ${key}: ${JSON.stringify(sm[key])} != ${JSON.stringify(dm[key])}`,
        });
        break;
      }
    }
  }

  return {
    mismatched,
    missing,
    prefixCounts: { destination: countPrefixes(dst), source: countPrefixes(src) },
    sha256Counts: { destination: countSha256(dst), source: countSha256(src) },
  };
}

export function isClean(report: CopyReport): boolean {
  return report.missing.length === 0 && report.mismatched.length === 0;
}

async function main(): Promise<number> {
  const [srcPath, dstPath] = process.argv.slice(2);
  if (!srcPath || !dstPath) {
    console.error('usage: verify-object-copy.ts <source.json> <destination.json>');
    return 1;
  }
  const source = (await Bun.file(srcPath).json()) as LsjsonEntry[];
  const destination = (await Bun.file(dstPath).json()) as LsjsonEntry[];
  const report = diffObjectCopy(source, destination);

  console.log('Objects per prefix (source -> destination):');
  const prefixes = new Set([
    ...Object.keys(report.prefixCounts.source),
    ...Object.keys(report.prefixCounts.destination),
  ]);
  for (const p of [...prefixes].sort()) {
    console.log(
      `  ${p}  ${report.prefixCounts.source[p] ?? 0} -> ${report.prefixCounts.destination[p] ?? 0}`,
    );
  }
  console.log(
    `Objects carrying ${SHA256_KEY} (source -> destination): ` +
      `${report.sha256Counts.source} -> ${report.sha256Counts.destination}`,
  );

  if (isClean(report)) {
    console.log(
      'OK: every source object exists on the destination with identical size + metadata.',
    );
    return 0;
  }
  console.error(
    `FAILED: ${report.missing.length} missing, ${report.mismatched.length} with differing size/metadata.`,
  );
  for (const p of report.missing.slice(0, 20)) {
    console.error(`  missing   ${p}`);
  }
  for (const m of report.mismatched.slice(0, 20)) {
    console.error(`  mismatch  ${m.path}: ${m.reason}`);
  }
  return 1;
}

if (import.meta.main) {
  process.exit(await main());
}
