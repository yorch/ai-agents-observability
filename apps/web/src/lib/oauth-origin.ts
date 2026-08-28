const OAUTH_CALLBACK_PATH = '/api/auth/callback';

/**
 * Resolves the origin that the browser can reach. A reverse proxy may expose a
 * public host while Next receives an internal container URL, so production
 * OAuth must use APP_BASE_URL rather than the request URL.
 */
export function publicAppOrigin({
  appBaseUrl,
  requestUrl,
  isProduction,
}: {
  appBaseUrl?: string | undefined;
  requestUrl: string;
  isProduction: boolean;
}): string {
  if (appBaseUrl) {
    const url = new URL(appBaseUrl);
    if (isProduction && url.protocol !== 'https:') {
      throw new Error('APP_BASE_URL must use HTTPS in production');
    }
    return url.origin;
  }

  if (isProduction) {
    throw new Error('APP_BASE_URL is required for OAuth in production');
  }

  return new URL(requestUrl).origin;
}

export function oauthCallbackUrl(origin: string): string {
  return new URL(OAUTH_CALLBACK_PATH, origin).toString();
}
