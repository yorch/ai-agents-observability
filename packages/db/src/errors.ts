/**
 * True when `err` is a Prisma unique-constraint violation (error code P2002).
 * Centralizes the Prisma-internal code so callers don't each hard-code the
 * 'P2002' string when handling create/upsert races and dedup conflicts.
 */
export function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'P2002';
}
