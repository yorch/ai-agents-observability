import { beforeEach, describe, expect, it } from 'bun:test';

import { commitDeferred, deferCommit, discardDeferred, resetDeferred } from './deferred-commit';

/**
 * The contract `hook-entry` depends on to keep a consumed side channel and the
 * durable record of it from coming apart.
 *
 * Every case here is about the list being EMPTIED, not just acted on. The
 * registry is module state, so an entry left behind after one hook invocation
 * would run during the next — committing a cursor for events that were never
 * queued, which is the original bug wearing a different hat.
 */

beforeEach(resetDeferred);

describe('deferCommit / commitDeferred', () => {
  it('runs registered work in order and clears it', () => {
    const ran: string[] = [];
    deferCommit('first', () => ran.push('first'));
    deferCommit('second', () => ran.push('second'));

    commitDeferred();
    expect(ran).toEqual(['first', 'second']);

    // Cleared: a second commit must not re-run anything.
    commitDeferred();
    expect(ran).toEqual(['first', 'second']);
  });

  it('isolates a failing commit from the rest', () => {
    // One adapter's cursor write failing must not strand another's. The failed
    // one stays uncommitted, which re-reads next time — the safe direction.
    const ran: string[] = [];
    deferCommit('boom', () => {
      throw new Error('disk full');
    });
    deferCommit('after', () => ran.push('after'));

    expect(() => commitDeferred()).not.toThrow();
    expect(ran).toEqual(['after']);
  });

  it('does not throw when a commit throws a non-Error', () => {
    // `runHook` owes the host agent an exit 0, so nothing here may escape —
    // including the message extraction itself.
    deferCommit('weird', () => {
      throw 'a string';
    });
    expect(() => commitDeferred()).not.toThrow();
  });
});

describe('discardDeferred', () => {
  it('drops registered work without running it, and clears', () => {
    let ran = false;
    deferCommit('cursor', () => {
      ran = true;
    });

    discardDeferred('enqueue_failed');
    expect(ran).toBe(false);

    // Cleared: a later commit must not resurrect it. This is the property that
    // stops one invocation's abandoned work from firing during the next.
    commitDeferred();
    expect(ran).toBe(false);
  });

  it('is a no-op when nothing is pending', () => {
    expect(() => discardDeferred('nothing')).not.toThrow();
  });
});

describe('resetDeferred', () => {
  it('clears pending work silently', () => {
    let ran = false;
    deferCommit('cursor', () => {
      ran = true;
    });

    resetDeferred();
    commitDeferred();
    expect(ran).toBe(false);
  });
});
