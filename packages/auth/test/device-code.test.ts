import { describe, expect, it } from 'vitest';

import { pollDeviceFlow, startDeviceFlow } from '../src/device-code';

function fetchReturning(json: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(json), {
      headers: { 'content-type': 'application/json' },
      status: 200,
    })) as unknown as typeof fetch;
}

function fetchError(status: number, json: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(json), {
      headers: { 'content-type': 'application/json' },
      status,
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

  it('includes GitHub error_description in the thrown message on non-ok', async () => {
    await expect(
      pollDeviceFlow(
        'id',
        'secret',
        'dc',
        fetchError(400, {
          error: 'device_flow_disabled',
          error_description: 'Device Flow must be explicitly enabled for this App',
        }),
      ),
    ).rejects.toThrow('device_flow_disabled — Device Flow must be explicitly enabled for this App');
  });
});

describe('startDeviceFlow', () => {
  it('returns the device code on success', async () => {
    const res = await startDeviceFlow(
      'id',
      fetchReturning({
        device_code: 'dc',
        expires_in: 900,
        interval: 5,
        user_code: 'ABC-123',
        verification_uri: 'https://github.com/login/device',
      }),
    );
    expect(res.device_code).toBe('dc');
    expect(res.user_code).toBe('ABC-123');
  });

  it('includes GitHub error_description in the thrown message on non-ok', async () => {
    await expect(
      startDeviceFlow(
        'id',
        fetchError(400, {
          error: 'device_flow_disabled',
          error_description: 'Device Flow must be explicitly enabled for this App',
        }),
      ),
    ).rejects.toThrow('device_flow_disabled — Device Flow must be explicitly enabled for this App');
  });

  it('includes the error code even without a description', async () => {
    await expect(startDeviceFlow('id', fetchError(404, { error: 'Not Found' }))).rejects.toThrow(
      '404: Not Found',
    );
  });

  it('falls back to status-only when the body is not JSON', async () => {
    const fetchNonJson = (async () =>
      new Response('Gateway Timeout', {
        headers: { 'content-type': 'text/plain' },
        status: 504,
      })) as unknown as typeof fetch;
    await expect(startDeviceFlow('id', fetchNonJson)).rejects.toThrow('504');
  });
});
