import { describe, expect, it } from 'bun:test';

import { enrichPrNumbers } from './flusher';

type FakeGitEvent = {
  session_context: {
    git: {
      branch: string | null;
      owner: string | null;
      pr_number: number | null;
      remote_url: string | null;
      repo: string | null;
    } | null;
  };
};

function makeEvent(
  owner: string | null,
  repo: string | null,
  branch: string | null,
  prNumber: number | null = null,
  remoteUrl: string | null = 'git@github.com:acme/widget.git',
): FakeGitEvent {
  return {
    session_context: {
      git: owner ? { branch, owner, pr_number: prNumber, remote_url: remoteUrl, repo } : null,
    },
  };
}

const RESOLVER = async () => 42;

describe('enrichPrNumbers', () => {
  it('fills pr_number from the resolver', async () => {
    const events = [makeEvent('acme', 'widget', 'feature/foo')];
    await enrichPrNumbers(events, RESOLVER);
    expect((events[0] as FakeGitEvent).session_context.git?.pr_number).toBe(42);
  });

  it('calls the resolver only once per unique owner/repo/branch', async () => {
    const calls: string[] = [];
    const events = [
      makeEvent('acme', 'widget', 'feature/foo'),
      makeEvent('acme', 'widget', 'feature/foo'),
      makeEvent('acme', 'widget', 'feature/bar'),
    ];
    await enrichPrNumbers(events, async (owner, repo, branch) => {
      calls.push(`${owner}/${repo}#${branch}`);
      return 1;
    });
    expect(calls).toEqual(['acme/widget#feature/foo', 'acme/widget#feature/bar']);
  });

  it('does not overwrite an existing pr_number', async () => {
    const events = [makeEvent('acme', 'widget', 'main', 99)];
    await enrichPrNumbers(events, RESOLVER);
    expect((events[0] as FakeGitEvent).session_context.git?.pr_number).toBe(99);
  });

  it('skips events with no git context', async () => {
    const calls: string[] = [];
    const events = [makeEvent(null, null, null)];
    await enrichPrNumbers(events, async (owner) => {
      calls.push(owner);
      return 1;
    });
    expect(calls).toHaveLength(0);
  });

  it('leaves pr_number null when resolver returns null (no open PR)', async () => {
    const events = [makeEvent('acme', 'widget', 'feature/no-pr')];
    await enrichPrNumbers(events, async () => null);
    expect((events[0] as FakeGitEvent).session_context.git?.pr_number).toBeNull();
  });
});
