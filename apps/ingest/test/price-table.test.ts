import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { makeTestDeps } from './helpers.js';

describe('GET /v1/price-table', () => {
  it('returns 200 with a valid price table', async () => {
    const app = createApp({} as any, makeTestDeps());
    const res = await app.request('/v1/price-table');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('version');
    expect(body).toHaveProperty('prices');
    expect(res.headers.get('etag')).toBeTruthy();
    expect(res.headers.get('cache-control')).toMatch('public');
  });

  it('returns 304 when ETag matches', async () => {
    const app = createApp({} as any, makeTestDeps());
    const first = await app.request('/v1/price-table');
    const etag = first.headers.get('etag')!;

    const second = await app.request('/v1/price-table', {
      headers: { 'if-none-match': etag },
    });
    expect(second.status).toBe(304);
  });
});
