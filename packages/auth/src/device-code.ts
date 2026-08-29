import { getGitHubHost, getOAuthBase } from './github-host';

export type DeviceCodeStartResult = {
  device_code: string;
  expires_in: number;
  interval: number;
  user_code: string;
  verification_uri: string;
};

export async function startDeviceFlow(
  clientId: string,
  fetchFn: typeof fetch = fetch,
): Promise<DeviceCodeStartResult> {
  const host = getGitHubHost();
  const base = getOAuthBase(host);
  const res = await fetchFn(`${base}/login/device/code`, {
    body: new URLSearchParams({ client_id: clientId, scope: 'read:user read:org user:email' }),
    headers: { Accept: 'application/json' },
    method: 'POST',
  });
  if (!res.ok) {
    throw new Error(
      `GitHub device/code request failed: ${res.status}${await githubErrorDetail(res)}`,
    );
  }
  return res.json() as Promise<DeviceCodeStartResult>;
}

export type DevicePollResult =
  | { status: 'pending'; slowDown?: boolean; interval?: number }
  | { status: 'authorized'; access_token: string };

export async function pollDeviceFlow(
  clientId: string,
  clientSecret: string,
  deviceCode: string,
  fetchFn: typeof fetch = fetch,
): Promise<DevicePollResult> {
  const host = getGitHubHost();
  const base = getOAuthBase(host);
  const res = await fetchFn(`${base}/login/oauth/access_token`, {
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }),
    headers: { Accept: 'application/json' },
    method: 'POST',
  });
  if (!res.ok) {
    throw new Error(`GitHub device poll failed: ${res.status}${await githubErrorDetail(res)}`);
  }
  const body = (await res.json()) as {
    access_token?: string;
    error?: string;
    interval?: number;
  };

  if (body.access_token) {
    return { access_token: body.access_token, status: 'authorized' };
  }
  if (body.error === 'authorization_pending') {
    return { status: 'pending' };
  }
  // GitHub asks us to back off — surface it so the poller widens its interval
  // (GitHub returns the new minimum interval). Ignoring this risks being blocked.
  if (body.error === 'slow_down') {
    return body.interval !== undefined
      ? { interval: body.interval, slowDown: true, status: 'pending' }
      : { slowDown: true, status: 'pending' };
  }
  throw new Error(`Device flow error: ${body.error}`);
}

// GitHub returns structured errors as JSON: {"error":"device_flow_disabled",
// "error_description":"Device Flow must be explicitly enabled for this App"}.
// Without this, the thrown error only carries the HTTP status (e.g. "400"),
// forcing a server log dive to discover the underlying cause.
// NOTE: consumes res.body — callers must throw immediately after.
async function githubErrorDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as unknown;
    if (typeof body === 'object' && body !== null) {
      const { error, error_description } = body as { error?: string; error_description?: string };
      if (typeof error === 'string' && error) {
        const desc = typeof error_description === 'string' ? ` — ${error_description}` : '';
        return `: ${error}${desc}`;
      }
    }
  } catch {
    // Non-JSON body — nothing to add beyond the status code.
  }
  return '';
}
