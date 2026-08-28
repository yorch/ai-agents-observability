import { describe, expect, it } from 'vitest';

import { oauthCallbackUrl, publicAppOrigin } from '../src/lib/oauth-origin.js';

describe('publicAppOrigin', () => {
  it('uses APP_BASE_URL instead of an internal reverse-proxy request URL', () => {
    expect(
      publicAppOrigin({
        appBaseUrl: 'https://agentometry.brnby.com/',
        isProduction: true,
        requestUrl: 'https://0.0.0.0:3000/api/auth/login',
      }),
    ).toBe('https://agentometry.brnby.com');
  });

  it('uses the request origin for local development without APP_BASE_URL', () => {
    expect(
      publicAppOrigin({
        isProduction: false,
        requestUrl: 'http://localhost:3000/api/auth/login',
      }),
    ).toBe('http://localhost:3000');
  });

  it('rejects a production OAuth flow without a canonical public origin', () => {
    expect(() =>
      publicAppOrigin({
        isProduction: true,
        requestUrl: 'https://0.0.0.0:3000/api/auth/login',
      }),
    ).toThrow('APP_BASE_URL is required for OAuth in production');
  });

  it('requires HTTPS for a production public origin', () => {
    expect(() =>
      publicAppOrigin({
        appBaseUrl: 'http://agentometry.brnby.com',
        isProduction: true,
        requestUrl: 'http://0.0.0.0:3000/api/auth/login',
      }),
    ).toThrow('APP_BASE_URL must use HTTPS in production');
  });
});

describe('oauthCallbackUrl', () => {
  it('uses one stable callback path', () => {
    expect(oauthCallbackUrl('https://agentometry.brnby.com')).toBe(
      'https://agentometry.brnby.com/api/auth/callback',
    );
  });
});
