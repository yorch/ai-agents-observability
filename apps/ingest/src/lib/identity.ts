import type { Context } from 'hono';
import type { Logger } from 'pino';

import type { AppEnv } from '../types.js';

/**
 * Compares a hook-asserted user_id_claim against the authoritative token identity.
 * On mismatch, logs a warning and returns the token identity — never trust the claim.
 * See DESIGN_DOC §6.5.
 */
export function verifyIdentityClaim(
  c: Context<AppEnv>,
  claim: string | null | undefined,
  logger: Logger,
): string {
  const user = c.get('user');
  if (!user) {
    throw new Error('verifyIdentityClaim called before auth middleware');
  }

  if (claim && claim !== user.id) {
    logger.warn(
      {
        claimed_user_id: claim,
        event: 'suspicious_identity_claim',
        reqId: c.get('requestId'),
        token_user_id: user.id,
      },
      'identity claim mismatch — using token identity',
    );
  }

  return user.id;
}
