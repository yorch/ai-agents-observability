import { importPKCS8, SignJWT } from 'jose';

type TokenCache = { token: string; expiresAt: number };
const cache = new Map<number, TokenCache>();

export async function getAppJwt(appId: number, privateKeyPem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const privateKey = await importPKCS8(privateKeyPem, 'RS256');
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt(now - 60)
    .setExpirationTime(now + 540) // 9 minutes (GitHub max is 10)
    .setIssuer(String(appId))
    .sign(privateKey);
}

export async function getInstallationToken(
  installationId: number,
  appId: number,
  privateKeyPem: string,
  githubHost: string,
): Promise<string> {
  const cached = cache.get(installationId);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.token;
  }

  const jwt = await getAppJwt(appId, privateKeyPem);
  const apiBase =
    githubHost === 'https://github.com'
      ? 'https://api.github.com'
      : `${githubHost}/api/v3`;

  const res = await fetch(`${apiBase}/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (!res.ok) {
    throw new Error(`Failed to get installation token: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as { token: string; expires_at: string };
  const expiresAt = new Date(data.expires_at).getTime();
  cache.set(installationId, { token: data.token, expiresAt });
  return data.token;
}
