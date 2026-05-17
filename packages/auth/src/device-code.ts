const GITHUB_COM_HOST = 'https://github.com';

function getHost(): string {
  return (process.env.GITHUB_HOST ?? GITHUB_COM_HOST).replace(/\/$/, '');
}

function oauthBase(host: string): string {
  return host === GITHUB_COM_HOST ? 'https://github.com' : host;
}

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
  const host = getHost();
  const base = oauthBase(host);
  const res = await fetchFn(`${base}/login/device/code`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, scope: 'read:user read:org user:email' }),
  });
  if (!res.ok) throw new Error(`GitHub device/code request failed: ${res.status}`);
  return res.json() as Promise<DeviceCodeStartResult>;
}

export type DevicePollResult =
  | { status: 'pending' }
  | { status: 'authorized'; access_token: string };

export async function pollDeviceFlow(
  clientId: string,
  clientSecret: string,
  deviceCode: string,
  fetchFn: typeof fetch = fetch,
): Promise<DevicePollResult> {
  const host = getHost();
  const base = oauthBase(host);
  const res = await fetchFn(`${base}/login/oauth/access_token`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }),
  });
  if (!res.ok) throw new Error(`GitHub device poll failed: ${res.status}`);
  const body = (await res.json()) as { access_token?: string; error?: string };

  if (body.access_token) {
    return { status: 'authorized', access_token: body.access_token };
  }
  if (body.error === 'authorization_pending' || body.error === 'slow_down') {
    return { status: 'pending' };
  }
  throw new Error(`Device flow error: ${body.error}`);
}
