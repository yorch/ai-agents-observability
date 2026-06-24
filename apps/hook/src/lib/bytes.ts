// Byte length of a payload field, treating both `undefined` and JSON `null` as
// empty (JSON.stringify(null) would otherwise count as the 4 bytes of "null").
// Shared by every hook adapter so byte-count semantics never diverge between
// agents.
export function fieldBytes(value: unknown): number {
  if (value == null) {
    return 0;
  }
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  return Buffer.byteLength(str, 'utf8');
}
