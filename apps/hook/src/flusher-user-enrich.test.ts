import { describe, expect, it } from 'bun:test';

import { enrichGitHubLogin, enrichProjectName, enrichUserTeam } from './flusher';

type FakeEvent = {
  session_context: {
    cwd: string;
    git: {
      github_login?: string | null;
      owner: string | null;
      team?: string | null;
    } | null;
    project_name?: string | null;
  };
};

function makeEvent(owner: string | null, cwd = '/home/user/project'): FakeEvent {
  return {
    session_context: {
      cwd,
      git: owner ? { owner } : null,
    },
  };
}

// ── enrichGitHubLogin ───────────────────────────────────────────────────────

describe('enrichGitHubLogin', () => {
  it('sets github_login from the resolver', () => {
    const events = [makeEvent('acme')];
    enrichGitHubLogin(events, () => 'jsmith');
    expect((events[0] as FakeEvent).session_context.git?.github_login).toBe('jsmith');
  });

  it('calls the resolver at most once regardless of event count', () => {
    let calls = 0;
    const events = [makeEvent('acme'), makeEvent('acme'), makeEvent('other')];
    enrichGitHubLogin(events, () => {
      calls++;
      return 'jsmith';
    });
    expect(calls).toBe(1);
  });

  it('does not overwrite an existing github_login', () => {
    const events = [makeEvent('acme')];
    const event = events[0] as FakeEvent;
    if (event.session_context.git) {
      event.session_context.git.github_login = 'existing';
    }
    enrichGitHubLogin(events, () => 'jsmith');
    expect((events[0] as FakeEvent).session_context.git?.github_login).toBe('existing');
  });

  it('skips events with no git context', () => {
    let calls = 0;
    const events = [makeEvent(null)];
    enrichGitHubLogin(events, () => {
      calls++;
      return 'jsmith';
    });
    expect(calls).toBe(0);
  });

  it('leaves github_login unset when resolver returns null', () => {
    const events = [makeEvent('acme')];
    enrichGitHubLogin(events, () => null);
    expect((events[0] as FakeEvent).session_context.git?.github_login).toBeUndefined();
  });
});

// ── enrichUserTeam ──────────────────────────────────────────────────────────

describe('enrichUserTeam', () => {
  it('sets team from the resolver', () => {
    const events = [makeEvent('acme')];
    enrichUserTeam(events, () => 'platform');
    expect((events[0] as FakeEvent).session_context.git?.team).toBe('platform');
  });

  it('calls the resolver only once per unique owner', () => {
    const calls: string[] = [];
    const events = [makeEvent('acme'), makeEvent('acme'), makeEvent('other')];
    enrichUserTeam(events, (owner) => {
      calls.push(owner);
      return 'platform';
    });
    expect(calls).toEqual(['acme', 'other']);
  });

  it('does not overwrite an existing team', () => {
    const events = [makeEvent('acme')];
    const event = events[0] as FakeEvent;
    if (event.session_context.git) {
      event.session_context.git.team = 'existing-team';
    }
    enrichUserTeam(events, () => 'platform');
    expect((events[0] as FakeEvent).session_context.git?.team).toBe('existing-team');
  });

  it('skips events with no git context or no owner', () => {
    let calls = 0;
    const events = [makeEvent(null)];
    enrichUserTeam(events, () => {
      calls++;
      return 'platform';
    });
    expect(calls).toBe(0);
  });

  it('leaves team unset when resolver returns null', () => {
    const events = [makeEvent('acme')];
    enrichUserTeam(events, () => null);
    expect((events[0] as FakeEvent).session_context.git?.team).toBeUndefined();
  });
});

// ── enrichProjectName ───────────────────────────────────────────────────────

describe('enrichProjectName', () => {
  it('sets project_name from the resolver', () => {
    const events = [makeEvent('acme')];
    enrichProjectName(events, () => 'my-app');
    expect((events[0] as FakeEvent).session_context.project_name).toBe('my-app');
  });

  it('calls the resolver only once per unique cwd', () => {
    const calls: string[] = [];
    const events = [
      makeEvent('acme', '/home/user/a'),
      makeEvent('acme', '/home/user/a'),
      makeEvent('acme', '/home/user/b'),
    ];
    enrichProjectName(events, (cwd) => {
      calls.push(cwd);
      return 'my-app';
    });
    expect(calls).toEqual(['/home/user/a', '/home/user/b']);
  });

  it('does not overwrite an existing project_name', () => {
    const events = [makeEvent('acme')];
    const event = events[0] as FakeEvent;
    event.session_context.project_name = 'existing-name';
    enrichProjectName(events, () => 'new-name');
    expect((events[0] as FakeEvent).session_context.project_name).toBe('existing-name');
  });

  it('skips events with no cwd', () => {
    let calls = 0;
    const event = {
      session_context: { cwd: '', git: null },
    };
    enrichProjectName([event], () => {
      calls++;
      return 'my-app';
    });
    expect(calls).toBe(0);
  });

  it('leaves project_name unset when resolver returns null', () => {
    const events = [makeEvent('acme')];
    enrichProjectName(events, () => null);
    expect((events[0] as FakeEvent).session_context.project_name).toBeUndefined();
  });
});
