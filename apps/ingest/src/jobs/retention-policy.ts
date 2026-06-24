/**
 * Effective transcript retention for a team (P9-004): the team override if set,
 * else the global default — clamped to the org maximum. A team with no override
 * (teamOverride === null) resolves to min(globalDefault, orgMax), i.e. exactly the
 * pre-P9-004 behavior. Clamping is applied here / at query time, never at write
 * time, so a misconfigured override can never block ingestion.
 *
 * Kept free of any Prisma import so it's unit-testable without the generated client.
 */
export function effectiveRetentionDays(
  teamOverride: number | null,
  globalDefault: number,
  orgMax: number,
): number {
  return Math.min(teamOverride ?? globalDefault, orgMax);
}
