import { describe, expect, it } from 'vitest';

import { oauthErrorDetails, oauthErrorLocation } from '../src/lib/oauth-errors';

const REQUEST_ID = '917ae065-bc20-4c85-8fe1-028bcb440839';

describe('oauthErrorLocation', () => {
  it('builds a relative login redirect from controlled values', () => {
    expect(oauthErrorLocation('unexpected', REQUEST_ID)).toBe(
      `/login?auth_error=unexpected&request_id=${REQUEST_ID}`,
    );
  });

  it('omits an invalid request ID', () => {
    expect(oauthErrorLocation('unexpected', 'attacker-controlled')).toBe(
      '/login?auth_error=unexpected',
    );
  });
});

describe('oauthErrorDetails', () => {
  it('returns a safe message and valid support reference', () => {
    expect(oauthErrorDetails('provider', REQUEST_ID)).toEqual({
      message: 'GitHub sign-in could not be completed. Please try again.',
      requestId: REQUEST_ID,
    });
  });

  it('ignores unknown, prototype, and repeated error codes', () => {
    expect(oauthErrorDetails('attacker-controlled', REQUEST_ID)).toBeNull();
    expect(oauthErrorDetails('__proto__', REQUEST_ID)).toBeNull();
    expect(oauthErrorDetails('toString', REQUEST_ID)).toBeNull();
    expect(oauthErrorDetails(['provider', 'unexpected'], REQUEST_ID)).toBeNull();
  });

  it('hides invalid request IDs', () => {
    expect(oauthErrorDetails('unexpected', 'not-a-request-id')).toEqual({
      message: 'We could not complete your sign-in. Please try again.',
      requestId: null,
    });
  });
});
