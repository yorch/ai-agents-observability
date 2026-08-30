import { describe, expect, it } from 'vitest';

import { getClientIp } from '../src/middleware/rate-limit';

function makeReq(headers: Record<string, string | undefined>) {
  return {
    header: (name: string) => headers[name.toLowerCase()],
  };
}

describe('getClientIp trusted-proxy logic', () => {
  it('takes Nth-from-right with trusted_proxy_count=1', () => {
    const req = makeReq({ 'x-forwarded-for': '1.2.3.4, 10.0.0.1' });
    expect(getClientIp(req, '10.0.0.1', 1)).toBe('1.2.3.4');
  });

  it('takes Nth-from-right with trusted_proxy_count=2', () => {
    const req = makeReq({ 'x-forwarded-for': '1.2.3.4, 10.0.0.1, 10.0.0.2' });
    expect(getClientIp(req, '10.0.0.2', 2)).toBe('1.2.3.4');
  });

  it('ignores XFF when trusted_proxy_count is unset', () => {
    const req = makeReq({ 'x-forwarded-for': '1.2.3.4, 10.0.0.1' });
    expect(getClientIp(req, '10.0.0.1', undefined)).toBe('10.0.0.1');
  });

  it('ignores XFF when trusted_proxy_count=0', () => {
    const req = makeReq({ 'x-forwarded-for': '1.2.3.4, 10.0.0.1' });
    expect(getClientIp(req, '10.0.0.1', 0)).toBe('10.0.0.1');
  });

  it('falls back to remoteAddr when XFF is absent', () => {
    const req = makeReq({});
    expect(getClientIp(req, '192.168.1.1', 1)).toBe('192.168.1.1');
  });

  it('falls back to unknown when neither XFF nor remoteAddr', () => {
    const req = makeReq({});
    expect(getClientIp(req, undefined, 1)).toBe('unknown');
  });

  it('handles spoofed XFF with more entries than trusted count', () => {
    // Client sends "spoofed, real, proxy" with trusted_proxy_count=1.
    // Nth-from-right (index = 3 - 1 - 1 = 1) → "real", not the spoofed first entry.
    const req = makeReq({ 'x-forwarded-for': 'spoofed-ip, real-client, 10.0.0.1' });
    expect(getClientIp(req, '10.0.0.1', 1)).toBe('real-client');
  });

  it('falls back to remoteAddr when XFF has fewer hops than trusted count + 1', () => {
    const req = makeReq({ 'x-forwarded-for': '10.0.0.1' });
    // trusted_proxy_count=2 but only 1 hop → idx = 1 - 2 - 1 = -2 < 0
    expect(getClientIp(req, '10.0.0.1', 2)).toBe('10.0.0.1');
  });
});
