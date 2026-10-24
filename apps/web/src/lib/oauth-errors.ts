import type { Dictionary } from '@/i18n/dictionary';

export const OAUTH_ERROR_CODES = [
  'invalid_request',
  'invalid_state',
  'provider',
  'unexpected',
] as const;

export type OAuthErrorCode = (typeof OAUTH_ERROR_CODES)[number];

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isOAuthErrorCode(value: string): value is OAuthErrorCode {
  return (OAUTH_ERROR_CODES as readonly string[]).includes(value);
}

export function oauthErrorLocation(code: OAuthErrorCode, requestId: string): string {
  const search = new URLSearchParams({ auth_error: code });
  if (REQUEST_ID_PATTERN.test(requestId)) {
    search.set('request_id', requestId);
  }
  return `/login?${search}`;
}

export function oauthErrorDetails(
  errorCode: string | string[] | undefined,
  requestId: string | string[] | undefined,
  dict: Dictionary,
): { message: string; requestId: string | null } | null {
  if (typeof errorCode !== 'string' || !isOAuthErrorCode(errorCode)) {
    return null;
  }
  return {
    message: dict.oauthErrors[errorCode],
    requestId:
      typeof requestId === 'string' && REQUEST_ID_PATTERN.test(requestId) ? requestId : null,
  };
}
