import { uuidv5 } from './uuid5';

// Session-ID normalization for the adapter seam (P12-002).
//
// `EventSchema` requires `session_id` to be a UUID, and ingest validates each event
// individually and DROPS the ones that fail (routes/events.ts) — tolerant by design,
// which means a malformed id is silently lost rather than loudly rejected. Most
// agents do not hand out UUIDs:
//
//   claude-code  8f4e…-…                    UUID          → pass through
//   pi           <timestamp>_<uuid>.jsonl   UUID          → pass through
//   opencode     ses_7bQ…                   NOT a UUID    → derive
//   omp          1f9d2a6b9c0d1234           NOT a UUID    → derive
//   codex/copilot/gemini                    unspecified   → derive when not a UUID
//
// Derivation is UUIDv5 over `<agent_type>:<native id>`, so it is stable across
// processes (the same session's events all agree) and namespaced by agent (two
// agents that both hand out `ses_abc` do not collide).

/**
 * Fixed namespace for derived session IDs. NEVER change this value — every event
 * of an in-flight session would re-derive to a different id and split the session
 * in two.
 */
export const SESSION_NAMESPACE = '3c5f8a12-7d4e-5b96-a081-6e2c94f7b3d5';

export const NIL_UUID = '00000000-0000-0000-0000-000000000000';

// Must match what `EventSchema` accepts, not merely "looks like a UUID". zod's
// `z.uuid()` enforces RFC 9562 — version nibble 1-8 and variant nibble 8|9|a|b —
// so a looser test here would declare a dashed-hex string "already a UUID", skip
// derivation, and hand ingest an id it drops on the floor. That is precisely the
// silent-drop failure P12-002 exists to prevent, so keep the two in lockstep.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * A valid UUID for `agentType`'s session `nativeId`.
 *
 * Already-UUID ids pass through unchanged (lowercased) so agents that hand out real
 * UUIDs keep their own identifier — the one users see in the agent's own UI. Anything
 * else is derived deterministically. Missing/empty ids collapse to the nil UUID, the
 * pre-existing "unknown session" sentinel.
 */
export function sessionUuid(agentType: string, nativeId: unknown): string {
  const native = normalizeNative(nativeId);
  if (native === null) {
    return NIL_UUID;
  }
  if (native === NIL_UUID || UUID_RE.test(native)) {
    return native.toLowerCase();
  }
  return uuidv5(`${agentType}:${native}`, SESSION_NAMESPACE);
}

// A numeric or otherwise non-string id is stringified rather than collapsed to
// the nil UUID: collapsing would merge every session of that agent into one row.
// Only genuinely absent/empty ids fall through to the sentinel.
function normalizeNative(nativeId: unknown): string | null {
  if (typeof nativeId === 'string') {
    return nativeId.length > 0 ? nativeId : null;
  }
  if (typeof nativeId === 'number' && Number.isFinite(nativeId)) {
    return String(nativeId);
  }
  if (typeof nativeId === 'bigint') {
    return String(nativeId);
  }
  return null;
}
