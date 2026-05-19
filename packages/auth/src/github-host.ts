export const GITHUB_COM_HOST = 'https://github.com';

export function getGitHubHost(): string {
  return (process.env.GITHUB_HOST ?? GITHUB_COM_HOST).replace(/\/$/, '');
}

export function getOAuthBase(host: string): string {
  return host === GITHUB_COM_HOST ? 'https://github.com' : host;
}
