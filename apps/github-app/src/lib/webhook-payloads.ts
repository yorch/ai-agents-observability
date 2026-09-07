import { z } from 'zod';

/**
 * Structural validation for the four webhook payloads we act on.
 *
 * WHY THIS EXISTS
 *
 * The HMAC covers the request BODY only. `X-GitHub-Event` — which selects the
 * handler — is not signed, so the pairing of a body with a handler is
 * attacker-controlled: a captured `push` body can be replayed as
 * `pull_request_review` and reaches a handler that immediately does
 * `review.state.toUpperCase()` on an undefined `review`. Until now every payload
 * was a CAST (`payload as EmitterWebhookEvent<'pull_request'>['payload']`),
 * which is a claim the runtime never checks, so the first evidence of a mismatch
 * was a thrown TypeError inside a detached async block.
 *
 * WHY THESE ARE MINIMAL AND LOOSE, NOT FULL GITHUB SCHEMAS
 *
 * Each schema requires exactly the fields its handler dereferences WITHOUT a
 * guard, and nothing else. That is deliberate in both directions:
 *
 *   - Too loose and it admits the mis-routed body this exists to reject.
 *   - Too STRICT and it silently drops real telemetry. GitHub adds and reshapes
 *     payload fields on its own schedule; a schema that enumerated everything
 *     would start rejecting genuine deliveries the day a field moved, and
 *     because we ack 202 before validating, those deliveries are gone. `z.looseObject`
 *     lets unknown keys through — the same choice `packages/schemas/repo-config.ts`
 *     makes for the same reason.
 *
 * A field the handler already null-checks stays optional here; making it
 * required would reject payloads the handler is perfectly able to process.
 *
 * NULLISH, NOT OPTIONAL, and this is not a style preference. GitHub sends
 * absent structures as explicit `null`, not by omitting the key --
 * `installation: null` on a GHES pull_request payload, for one. `.optional()`
 * admits `undefined` and REJECTS `null`, so the first version of this file
 * rejected every real fixture in test/fixtures/ghes while type-checking
 * perfectly. Since we ack 202 before validating, that would have silently
 * dropped every pull_request delivery on a GHES install.
 */

/** Every event we handle names its repository. */
const Repository = z.looseObject({
  default_branch: z.string().nullish(),
  full_name: z.string().nullish(),
});

/**
 * `pull_request`. `number` and `head.ref` are dereferenced unguarded;
 * `merged`, `title`, `body` and `created_at` are all guarded at the call site.
 */
export const PullRequestPayloadSchema = z.looseObject({
  action: z.string(),
  installation: z.looseObject({ id: z.number() }).nullish(),
  pull_request: z.looseObject({
    body: z.string().nullish(),
    created_at: z.string().nullish(),
    head: z.looseObject({ ref: z.string() }),
    merged: z.boolean().nullish(),
    number: z.number(),
    title: z.string().nullish(),
  }),
  repository: Repository.extend({ full_name: z.string() }),
});

/**
 * `pull_request_review`. `review.state` is the one that matters: the handler
 * calls `.toUpperCase()` on it directly, which is exactly what a replayed
 * body of another type used to hit.
 */
export const PullRequestReviewPayloadSchema = z.looseObject({
  action: z.string(),
  pull_request: z.looseObject({ number: z.number() }),
  repository: Repository.extend({ full_name: z.string() }),
  review: z.looseObject({ state: z.string() }),
});

/** `check_run`. The handler guards `check_run` itself, but not its interior. */
export const CheckRunPayloadSchema = z.looseObject({
  action: z.string().nullish(),
  check_run: z
    .looseObject({
      completed_at: z.string().nullish(),
      conclusion: z.string().nullish(),
      head_sha: z.string().nullish(),
      id: z.number(),
      name: z.string(),
      pull_requests: z.array(z.looseObject({ number: z.number() })),
      started_at: z.string().nullish(),
      status: z.string(),
    })
    .nullish(),
  repository: Repository.nullish(),
});

/** `push`. Everything is guarded downstream, so this is a shape check only. */
export const PushPayloadSchema = z.looseObject({
  commits: z
    .array(
      z.looseObject({
        author: z.looseObject({ username: z.string().nullish() }).nullish(),
        id: z.string(),
        timestamp: z.string().nullish(),
      }),
    )
    .nullish(),
  ref: z.string().nullish(),
  repository: Repository.nullish(),
});
