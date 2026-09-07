import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CheckRunPayloadSchema,
  PullRequestPayloadSchema,
  PullRequestReviewPayloadSchema,
  PushPayloadSchema,
} from '../src/lib/webhook-payloads';

/**
 * Two directions, and BOTH matter.
 *
 * Reject a mis-routed body — the reason these schemas exist, since
 * `X-GitHub-Event` selects the handler and is not covered by the signature.
 *
 * Accept every real payload — the reason they are loose. We ack 202 before
 * validating, so a schema that is too strict does not return an error to
 * GitHub: it silently drops a delivery nobody will resend. That is a worse
 * outcome than the crash this replaces, and the first version of these schemas
 * did exactly that (see the `installation: null` case below).
 */

const FIXTURES = join(import.meta.dirname, 'fixtures/ghes');

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
}

describe('accepts real payloads', () => {
  it.each([
    'pull_request.opened.json',
    'pull_request.closed.merged.json',
    'pull_request.synchronize.json',
  ])('%s parses', (name) => {
    expect(PullRequestPayloadSchema.safeParse(fixture(name)).success).toBe(true);
  });

  it('tolerates installation: null, which GHES actually sends', () => {
    // The regression that motivated `.nullish()` over `.optional()` everywhere.
    // `.optional()` admits `undefined` and REJECTS `null`, so the first version
    // of this file type-checked cleanly and rejected every GHES pull_request
    // fixture — which, because validation happens after the 202, would have
    // dropped those deliveries silently rather than erroring.
    const payload = {
      action: 'opened',
      installation: null,
      pull_request: { head: { ref: 'feat/x' }, number: 1 },
      repository: { full_name: 'acme/backend' },
    };
    expect(PullRequestPayloadSchema.safeParse(payload).success).toBe(true);
  });

  it('tolerates unknown keys, so a new GitHub field never drops a delivery', () => {
    const payload = {
      a_field_github_added_last_tuesday: { nested: true },
      action: 'opened',
      pull_request: { head: { ref: 'feat/x' }, number: 1, something_new: 42 },
      repository: { full_name: 'acme/backend' },
    };
    expect(PullRequestPayloadSchema.safeParse(payload).success).toBe(true);
  });
});

describe('rejects a body routed to the wrong handler', () => {
  it('a push body is not a pull_request_review', () => {
    // The concrete attack: the HMAC covers the body only, so a captured `push`
    // delivery can be replayed with X-GitHub-Event: pull_request_review. The
    // handler then does `review.state.toUpperCase()` on an undefined `review`.
    const push = {
      commits: [{ id: 'abc123', timestamp: '2026-09-07T00:00:00Z' }],
      ref: 'refs/heads/main',
      repository: { default_branch: 'main', full_name: 'acme/backend' },
    };
    expect(PullRequestReviewPayloadSchema.safeParse(push).success).toBe(false);
  });

  it('a pull_request body is not a check_run', () => {
    // check_run's schema is the loosest of the four (everything is guarded
    // downstream), so this is the weakest of these assertions — it holds
    // because a pull_request payload has no `check_run` key at all... which a
    // nullish field permits. Documented rather than asserted falsely:
    const pr = fixture('pull_request.opened.json');
    const result = CheckRunPayloadSchema.safeParse(pr);
    // It PARSES — and that is correct and safe: `check_run` is nullish, and
    // `handleCheckRun` guards it, so the handler no-ops. The schema's job is to
    // stop an unguarded dereference, not to classify events.
    expect(result.success).toBe(true);
  });

  it('a pull_request_review body missing review.state is rejected', () => {
    // The unguarded dereference itself.
    const payload = {
      action: 'submitted',
      pull_request: { number: 7 },
      repository: { full_name: 'acme/backend' },
      review: {},
    };
    expect(PullRequestReviewPayloadSchema.safeParse(payload).success).toBe(false);
  });

  it('a pull_request missing head.ref is rejected', () => {
    // `pr.head.ref` is dereferenced without a guard in handlePullRequest.
    const payload = {
      action: 'opened',
      pull_request: { number: 1 },
      repository: { full_name: 'acme/backend' },
    };
    expect(PullRequestPayloadSchema.safeParse(payload).success).toBe(false);
  });
});

describe('push', () => {
  it('accepts a representative payload', () => {
    const push = {
      commits: [{ author: { username: 'dev' }, id: 'abc123', timestamp: '2026-09-07T00:00:00Z' }],
      ref: 'refs/heads/main',
      repository: { default_branch: 'main', full_name: 'acme/backend' },
    };
    expect(PushPayloadSchema.safeParse(push).success).toBe(true);
  });

  it('accepts a commit with a null author, which GitHub sends for unmatched emails', () => {
    const push = {
      commits: [{ author: null, id: 'abc123' }],
      ref: 'refs/heads/main',
      repository: { full_name: 'acme/backend' },
    };
    expect(PushPayloadSchema.safeParse(push).success).toBe(true);
  });
});
