import { randomBytes } from 'node:crypto';

// UUID v7: 48-bit unix_ts_ms | ver(4) | rand_a(12) | var(2) | rand_b(62)
// RFC 9562 §5.7. Sortable by time, randomness in the trailing bits.
export function uuidv7(): string {
  const bytes = randomBytes(16);
  const ms = BigInt(Date.now());

  bytes[0] = Number((ms >> 40n) & 0xffn);
  bytes[1] = Number((ms >> 32n) & 0xffn);
  bytes[2] = Number((ms >> 24n) & 0xffn);
  bytes[3] = Number((ms >> 16n) & 0xffn);
  bytes[4] = Number((ms >> 8n) & 0xffn);
  bytes[5] = Number(ms & 0xffn);

  // Set version (7) in the high nibble of byte 6
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  // Set variant (10xxxxxx) in the high bits of byte 8
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
