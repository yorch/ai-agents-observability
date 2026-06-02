import { describe, expect, it } from 'vitest';

import { pollDeviceFlow } from '../src/device-code';

function fetchReturning(json: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(json), {
      headers: { 'content-type': 'application/json' },
      status: 200,
    })) as unknown as typeof fetch;
}

describe('pollDeviceFlow', () => {
  it('returns authorized with the access token', async () => {
    const res = await pollDeviceFlow(
      'id',
      'secret',
      'dc',
      fetchReturning({ access_token: 'gho_x' }),
    );
    expect(res).toEqual({ access_token: 'gho_x', status: 'authorized' });
  });

  it('maps authorization_pending to pending', async () => {
    const res = await pollDeviceFlow(
      'id',
      'secret',
      'dc',
      fetchReturning({ error: 'authorization_pending' }),
    );
    expect(res).toEqual({ status: 'pending' });
  });

  it('surfaces slow_down with the new interval so the poller can back off', async () => {
    const res = await pollDeviceFlow(
      'id',
      'secret',
      'dc',
      fetchReturning({ error: 'slow_down', interval: 10 }),
    );
    expect(res).toEqual({ interval: 10, slowDown: true, status: 'pending' });
  });

  it('throws on a terminal error (e.g. expired_token)', async () => {
    await expect(
      pollDeviceFlow('id', 'secret', 'dc', fetchReturning({ error: 'expired_token' })),
    ).rejects.toThrow('expired_token');
  });
});
