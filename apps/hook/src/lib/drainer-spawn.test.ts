import { describe, expect, it } from 'bun:test';

import { drainerEnv } from './drainer-spawn';

describe('drainerEnv', () => {
  const agentShell = {
    AIOT_QUEUE_MAX_EVENTS: '1',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    GH_CONFIG_DIR: '/home/dev/.config/gh-work',
    GH_HOST: 'github.example.com',
    GH_TOKEN: 'gho_user',
    GITHUB_API_URL: 'https://attacker.example/api/v3',
    GITHUB_TOKEN: 'ghp_user',
    HOME: '/home/dev',
    HTTPS_PROXY: 'http://proxy.corp:3128',
    INGEST_BASE_URL: 'http://localhost:4000',
    OPENAI_API_KEY: 'sk-agentshell',
    PATH: '/usr/bin:/bin',
    XDG_RUNTIME_DIR: '/run/user/1000',
  };

  it('never forwards what redirects delivery, nor unrelated secrets', () => {
    const env = drainerEnv(agentShell, '/home/dev/.aiot');
    expect(env.INGEST_BASE_URL).toBeUndefined();
    expect(env.AIOT_QUEUE_MAX_EVENTS).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    // A token is never sent to a host the agent's shell chose.
    expect(env.GITHUB_API_URL).toBeUndefined();
  });

  it("keeps the user's GitHub auth and the keyring variables gh needs, plus state/network basics", () => {
    const env = drainerEnv(agentShell, '/home/dev/.aiot');
    expect(env).toEqual({
      AIOT_HOME: '/home/dev/.aiot',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      GH_CONFIG_DIR: '/home/dev/.config/gh-work',
      GH_HOST: 'github.example.com',
      GH_TOKEN: 'gho_user',
      GITHUB_TOKEN: 'ghp_user',
      HOME: '/home/dev',
      HTTPS_PROXY: 'http://proxy.corp:3128',
      PATH: '/usr/bin:/bin',
      XDG_RUNTIME_DIR: '/run/user/1000',
    });
  });

  it('passes variables only when they are set', () => {
    expect(drainerEnv({ HOME: '/h' }, '/h/.aiot')).toEqual({ AIOT_HOME: '/h/.aiot', HOME: '/h' });
  });
});
