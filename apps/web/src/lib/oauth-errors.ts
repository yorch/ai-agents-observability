export const OAUTH_ERROR_MESSAGES = {
  invalid_request: 'GitHub did not return the information needed to sign you in. Please try again.',
  invalid_state: 'Your sign-in session expired or could not be verified. Please try again.',
  provider: 'GitHub sign-in could not be completed. Please try again.',
  unexpected: 'We could not complete your sign-in. Please try again.',
} as const;

export type OAuthErrorCode = keyof typeof OAUTH_ERROR_MESSAGES;

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isOAuthErrorCode(value: string): value is OAuthErrorCode {
  return Object.hasOwn(OAUTH_ERROR_MESSAGES, value);
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
): { message: string; requestId: string | null } | null {
  if (typeof errorCode !== 'string' || !isOAuthErrorCode(errorCode)) {
    return null;
  }
  return {
    message: OAUTH_ERROR_MESSAGES[errorCode],
    requestId:
      typeof requestId === 'string' && REQUEST_ID_PATTERN.test(requestId) ? requestId : null,
  };
}
