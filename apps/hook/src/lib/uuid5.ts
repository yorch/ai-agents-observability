import { createHash } from 'node:crypto';

// Fixed namespace for claude-telemetry imports. NEVER change this value or
// re-imports will generate different IDs and create duplicates in the DB.
export const IMPORT_NAMESPACE = '6f1a4e2c-9b3d-5a8e-bc11-2f0a9d4e7c63';

function uuidToBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

function formatUuid(bytes: Buffer): string {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * RFC 4122 v5: SHA-1(namespace_bytes || name), first 16 bytes, version=5, variant=10.
 * Used internally; NOT used for event_id (which needs z.uuidv7() shape).
 */
export function uuidv5(name: string, namespace: string = IMPORT_NAMESPACE): string {
  const nsBytes = uuidToBytes(namespace);
  const hash = createHash('sha1').update(nsBytes).update(name).digest();
  const bytes = Buffer.from(hash.slice(0, 16));
  // Set version nibble = 5
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  // Set variant = 10xxxxxx
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  return formatUuid(bytes);
}

/**
 * Deterministic UUID that passes z.uuidv7() validation (version nibble = 7).
 * Derived from SHA-1(IMPORT_NAMESPACE || name), so the same name always
 * produces the same output — re-importing the same session is a no-op.
 * Not time-sortable; ingest only uses event_id for ON CONFLICT deduplication.
 */
export function deterministicEventId(name: string): string {
  const nsBytes = uuidToBytes(IMPORT_NAMESPACE);
  const hash = createHash('sha1').update(nsBytes).update(name).digest();
  const bytes = Buffer.from(hash.slice(0, 16));
  // Force version nibble = 7 instead of 5
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  // Set variant = 10xxxxxx
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  return formatUuid(bytes);
}
