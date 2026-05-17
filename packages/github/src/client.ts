import { enterpriseCompatibility } from '@octokit/plugin-enterprise-compatibility';
import { Octokit } from 'octokit';

const GITHUB_COM_HOST = 'https://github.com';
const GITHUB_COM_API = 'https://api.github.com';

function resolveApiBase(host: string): string {
  if (host === GITHUB_COM_HOST) {
    return GITHUB_COM_API;
  }
  return `${host}/api/v3`;
}

function isGhes(host: string): boolean {
  return host !== GITHUB_COM_HOST;
}

export type CreateGitHubClientOptions = {
  /** Override fetch for testing. */
  fetch?: typeof globalThis.fetch;
  host?: string;
  token: string;
};

export type GitHubClient = Octokit;

export function createGitHubClient(options: CreateGitHubClientOptions): GitHubClient {
  const host = (options.host ?? process.env.GITHUB_HOST ?? GITHUB_COM_HOST).replace(/\/$/, '');
  const baseUrl = resolveApiBase(host);
  const ghes = isGhes(host);

  const version = '0.0.0';
  const userAgent = `claude-telemetry/${version}`;

  const plugins = ghes ? [enterpriseCompatibility] : [];
  const OctokitWithPlugins = Octokit.plugin(...plugins);

  return new OctokitWithPlugins({
    auth: options.token,
    baseUrl,
    ...(options.fetch ? { request: { fetch: options.fetch } } : {}),
    userAgent,
  });
}
