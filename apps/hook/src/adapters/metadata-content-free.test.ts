import { CONTENT_BEARING_KEYS, MAX_METADATA_STRING } from '@ai-agents-observability/schemas';
import { describe, expect, it } from 'vitest';

import { ADAPTERS } from './index';

/**
 * The CLASS of bug fixed in P14-008, not the instance.
 *
 * The instance was Claude Code's `last_assistant_message` — a `Stop` /
 * `SubagentStop` payload field its own hook schema describes as "Text content of
 * the last assistant message before stopping" — landing verbatim in
 * `events.metadata`, a durable JSONB column nothing redacts. The instance was
 * never the point: every adapter's metadata builder was a denylist over keys the
 * adapter happened to know about, so *any* field a vendor adds later leaks the
 * same way. Copilot CLI's `userPromptSubmitted.prompt` was already leaking by the
 * same mechanism, for the same reason, and nobody had noticed.
 *
 * A test asserting `last_assistant_message` is excluded would be worth almost
 * nothing. This sweeps EVERY registered adapter over EVERY hook kind it installs,
 * feeding a payload that carries every content-bearing key at once, and asserts
 * none of it survives into metadata. Adding an agent to `ADAPTERS` enrols it
 * automatically; adding a key to `CONTENT_BEARING_KEYS` enrols it for all seven.
 *
 * THE ANTI-VACUITY HALF is the part that matters after a refactor. A metadata
 * builder that returned `{}` unconditionally would satisfy every assertion above
 * while destroying the passthrough this test is supposed to be policing — so the
 * sweep also tracks a benign CONTROL key and asserts it still rides through, on
 * exactly the adapters that have a passthrough at all. If that set changes, this
 * test fails and someone has to look at why.
 */

/** Recognisable, and impossible to produce by accident. */
const SENTINEL = 'P14-008-CONTENT-MUST-NOT-REACH-METADATA';

/**
 * A short scalar under a name no adapter models. This is what metadata is FOR
 * ("a payload field we have not modelled yet is preserved rather than dropped"),
 * so it must survive — that is what proves the sweep reached a live passthrough
 * rather than an empty object.
 */
const CONTROL_KEY = 'p14_008_control';
const CONTROL_VALUE = 'kept';

/**
 * Adapters whose `mapPayload` copies unmodelled payload keys into metadata.
 *
 * opencode is absent deliberately, not by oversight: `opencode.ts` builds
 * `metadata: {}` literally and never passes anything through, so it is
 * content-free by construction and has nothing for the filter to do.
 *
 * IF THIS ASSERTION FAILS because you added an agent: that is the point. Decide
 * whether the new adapter passes payload keys through, and if it does, make sure
 * it goes through `admitsToMetadata` before adding it here.
 */
const ADAPTERS_WITH_PASSTHROUGH = ['claude-code', 'codex', 'copilot', 'gemini-cli', 'omp', 'pi'];

const SESSION_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

/** Base payload: the fields every adapter needs to assemble an event at all. */
function basePayload(): Record<string, unknown> {
  return {
    cwd: '/repo',
    session_id: SESSION_ID,
    sessionId: SESSION_ID,
  };
}

/** Base payload plus every content-bearing key, each holding the sentinel. */
function payloadWithAllContentKeys(): Record<string, unknown> {
  const raw = basePayload();
  raw[CONTROL_KEY] = CONTROL_VALUE;
  for (const key of CONTENT_BEARING_KEYS) {
    raw[key] = SENTINEL;
  }
  return raw;
}

describe('the content-key corpus is non-vacuous', () => {
  it('names the fields this bug was actually found in', () => {
    // Sourced from the vendors' own hook schemas — Claude Code's Stop /
    // SubagentStop / PreCompact / SessionStart, Copilot CLI's userPromptSubmitted,
    // Gemini CLI's BeforeAgent. An empty or gutted list would make every sweep
    // below pass while checking nothing.
    expect(CONTENT_BEARING_KEYS.size).toBeGreaterThan(20);
    for (const key of [
      'custom_instructions',
      'last_assistant_message',
      'message',
      'prompt',
      'session_title',
    ]) {
      expect(CONTENT_BEARING_KEYS.has(key)).toBe(true);
    }
  });

  it('does not name the structural keys metadata exists to carry', () => {
    // A corpus that swallowed these would make the passthrough useless and the
    // anti-vacuity control below unrepresentative.
    for (const key of ['model', 'turn_id', 'notification_type', 'timestamp', 'source']) {
      expect(CONTENT_BEARING_KEYS.has(key)).toBe(false);
    }
  });
});

describe('no adapter passes user or model content through to events.metadata', () => {
  const keptControl = new Set<string>();

  for (const [name, adapter] of Object.entries(ADAPTERS)) {
    for (const kind of adapter.installConfig().hookKinds) {
      it(`${name} · ${kind}`, () => {
        const event = adapter.mapPayload(kind, payloadWithAllContentKeys());
        const serialized = JSON.stringify(event.metadata);

        // Serialized, not key-by-key: this also catches a leak under a RENAMED
        // key, or one nested inside an object an adapter chose to promote.
        expect(serialized).not.toContain(SENTINEL);
        for (const key of Object.keys(event.metadata)) {
          expect(CONTENT_BEARING_KEYS.has(key)).toBe(false);
        }

        if (event.metadata[CONTROL_KEY] === CONTROL_VALUE) {
          keptControl.add(name);
        }
      });
    }
  }

  it('still carries an unmodelled structural field (the passthrough is alive)', () => {
    expect([...keptControl].sort()).toEqual(ADAPTERS_WITH_PASSTHROUGH);
  });
});

describe('the shape rule refuses what no name list can anticipate', () => {
  for (const [name, adapter] of Object.entries(ADAPTERS)) {
    if (!ADAPTERS_WITH_PASSTHROUGH.includes(name)) {
      continue;
    }
    const kind = adapter.installConfig().hookKinds[0] as string;

    it(`${name} refuses a nested value under an unlisted name`, () => {
      // Where unbounded vendor content actually lives: Claude Code's
      // `background_tasks[].description`, Gemini's `llm_response`, Codex's
      // `tool_calls[]`. None of those names has to be known for this to hold.
      const event = adapter.mapPayload(kind, {
        ...basePayload(),
        p14_008_unlisted_array: [{ description: SENTINEL }],
        p14_008_unlisted_object: { nested: SENTINEL },
      });
      expect(JSON.stringify(event.metadata)).not.toContain(SENTINEL);
    });

    it(`${name} refuses an over-long string under an unlisted name`, () => {
      const event = adapter.mapPayload(kind, {
        ...basePayload(),
        p14_008_unlisted_prose: SENTINEL.padEnd(MAX_METADATA_STRING + 1, '.'),
      });
      expect(JSON.stringify(event.metadata)).not.toContain(SENTINEL);
    });
  }
});
