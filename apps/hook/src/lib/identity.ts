import { readFileSync } from 'node:fs';

import { identityPath } from './paths';

let cached: string | null = null;

// Identity is written by `aiot login` (P1-023). Until that runs we
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

/**
 * Load the hook auth token: `AIOT_TOKEN` if set, else the one written by
 * `aiot login` (the `token` field of the identity file). The env var wins so a
 * container can be provisioned without an interactive login. Returns null when
 * neither is present. Shared by the flusher, transcript shipper and import so
 * the read isn't duplicated. Read per call, never cached — a fresh `aiot login`
 * must be picked up by a running daemon. The token is a credential: never log it.
 */
export function loadHookToken(): string | null {
  const fromEnv = process.env.AIOT_TOKEN?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  try {
    const raw = readFileSync(identityPath(), 'utf8');
    const parsed = JSON.parse(raw) as { token?: unknown };
    if (typeof parsed.token === 'string' && parsed.token.length > 0) {
      return parsed.token;
    }
  } catch {
    // No identity file or unreadable.
  }
  return null;
}
