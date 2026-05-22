import { readFileSync } from 'node:fs';

import { identityPath } from './paths';

let cached: string | null = null;

// Identity is written by `claude-telemetry login` (P1-023). Until that runs we
// queue events with a placeholder claim — the ingest service is authoritative
// for identity (see DESIGN_DOC §6.5) so the claim is only a sanity check.
export function userIdClaim(): string {
  if (cached) {
    return cached;
  }
  try {
    const raw = readFileSync(identityPath(), 'utf8');
    const parsed = JSON.parse(raw) as { user_id_claim?: unknown };
    if (typeof parsed.user_id_claim === 'string' && parsed.user_id_claim.length > 0) {
      cached = parsed.user_id_claim;
      return cached;
    }
  } catch {
    // No identity file or unreadable — fall through to placeholder.
  }
  cached = 'pending-login';
  return cached;
}
