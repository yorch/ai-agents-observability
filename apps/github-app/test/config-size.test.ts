import { describe, expect, it } from 'vitest';

import { readCapped } from '../src/handlers/pull-request';

/**
 * `.aiot.yml` is fetched at the merge commit of the PR being processed, so its
 * contents are chosen by whoever got that PR merged, and GitHub's raw-content
 * endpoint serves files up to 100 MB.
 *
 * The first version of this guard checked `Content-Length` and then the length
 * of the decoded string. The tests below are written against the two ways that
 * actually failed, rather than against the shape of the new code:
 *
 *   - it buffered the whole body BEFORE deciding, so the allocation the cap
 *     exists to prevent had already happened;
 *   - `String.length` counts UTF-16 code units, so multi-byte content measured
 *     short and slipped under a byte cap.
 *
 * The first is observable only by watching how much of the stream the producer
 * is asked for, which is what `countingStream` is for. A test that merely
 * asserts `null` cannot tell the two implementations apart.
 */

const CAP = 1024;

/** A chunked body with no `Content-Length`, reporting how much it produced. */
function countingStream(chunks: number, chunkBytes: number) {
  let produced = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (produced >= chunks) {
        controller.close();
        return;
      }
      produced += 1;
      controller.enqueue(new Uint8Array(chunkBytes).fill(0x61));
    },
  });
  return { produced: () => produced, stream };
}

describe('readCapped', () => {
  it('reads a small body through unchanged', async () => {
    // Positive control: the cap is not simply rejecting everything.
    expect(await readCapped(new Response('version: 1\npr_bot:\n  enabled: true'), CAP)).toBe(
      'version: 1\npr_bot:\n  enabled: true',
    );
  });

  it('stops reading once the budget is gone, instead of buffering first', async () => {
    // THE test. A streamed body carries no Content-Length, so the header check
    // was a no-op and `text()` drained all 200 chunks into memory before the
    // size was ever considered. Bounding the read means the producer is asked
    // for only the few chunks needed to blow the budget.
    const { produced, stream } = countingStream(200, 512);

    const out = await readCapped(new Response(stream), CAP);

    expect(out).toBeNull();
    // 512-byte chunks against a 1024 cap: 3 reads to exceed it, not 200.
    expect(produced()).toBeLessThan(10);
  });

  it('counts BYTES, not UTF-16 code units', async () => {
    // Each emoji is 4 UTF-8 bytes but 2 UTF-16 units, so 400 of them are 1600
    // bytes while `.length` reports 800 — under the cap, and previously passed.
    const emoji = '\u{1F600}'.repeat(400);
    expect(emoji.length).toBeLessThan(CAP);
    expect(new TextEncoder().encode(emoji).byteLength).toBeGreaterThan(CAP);

    expect(await readCapped(new Response(emoji), CAP)).toBeNull();
  });

  it('accepts multi-byte content that genuinely fits', async () => {
    // Guards the fix against over-correcting: a small non-ASCII config is fine.
    const text = '# café ☕\nversion: 1';
    expect(await readCapped(new Response(text), CAP)).toBe(text);
  });

  it('returns null for a body-less response', async () => {
    expect(await readCapped(new Response(null, { status: 204 }), CAP)).toBeNull();
  });
});
