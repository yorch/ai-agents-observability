import { describe, expect, it } from 'bun:test';

import { enrichPrNumbers, enrichPrSnapshot } from './flusher';
import type { PrSnapshot } from './lib/github-pr';

type FakeGitEvent = {
  session_context: {
    git: {
      branch: string | null;
      owner: string | null;
      pr_ci_status?: string;
      pr_number: number | null;
      pr_review_decision?: string;
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

// ── enrichPrSnapshot ────────────────────────────────────────────────────────

const SNAP_OK: PrSnapshot = { ciStatus: 'SUCCESS', reviewDecision: 'APPROVED' };

function makeSnapshotEvent(
  owner: string | null,
  repo: string | null,
  prNumber: number | null,
): FakeGitEvent {
  return {
    session_context: {
      git: owner ? { branch: 'main', owner, pr_number: prNumber, remote_url: null, repo } : null,
    },
  };
}

describe('enrichPrSnapshot', () => {
  it('populates ci_status and review_decision from the resolver', () => {
    const events = [makeSnapshotEvent('acme', 'widget', 7)];
    enrichPrSnapshot(events, () => SNAP_OK);
    const git = (events[0] as FakeGitEvent).session_context.git;
    expect(git?.pr_ci_status).toBe('SUCCESS');
    expect(git?.pr_review_decision).toBe('APPROVED');
  });

  it('calls the resolver only once per unique owner/repo/prNumber', () => {
    const calls: string[] = [];
    const events = [
      makeSnapshotEvent('acme', 'widget', 7),
      makeSnapshotEvent('acme', 'widget', 7),
      makeSnapshotEvent('acme', 'widget', 8),
    ];
    enrichPrSnapshot(events, (owner, repo, prNum) => {
      calls.push(`${owner}/${repo}#${prNum}`);
      return SNAP_OK;
    });
    expect(calls).toEqual(['acme/widget#7', 'acme/widget#8']);
  });

  it('skips events that already have pr_ci_status set', () => {
    const calls: string[] = [];
    const event = makeSnapshotEvent('acme', 'widget', 7);
    (event.session_context.git as { pr_ci_status?: string }).pr_ci_status = 'PENDING';
    enrichPrSnapshot([event], () => {
      calls.push('called');
      return SNAP_OK;
    });
    expect(calls).toHaveLength(0);
  });

  it('skips events with no pr_number', () => {
    const calls: string[] = [];
    const events = [makeSnapshotEvent('acme', 'widget', null)];
    enrichPrSnapshot(events, () => {
      calls.push('called');
      return SNAP_OK;
    });
    expect(calls).toHaveLength(0);
  });

  it('skips events with no git context', () => {
    const calls: string[] = [];
    const events = [makeSnapshotEvent(null, null, null)];
    enrichPrSnapshot(events, () => {
      calls.push('called');
      return SNAP_OK;
    });
    expect(calls).toHaveLength(0);
  });

  it('leaves fields unset when resolver returns null', () => {
    const events = [makeSnapshotEvent('acme', 'widget', 7)];
    enrichPrSnapshot(events, () => null);
    const git = (events[0] as FakeGitEvent).session_context.git;
    expect(git?.pr_ci_status).toBeUndefined();
    expect(git?.pr_review_decision).toBeUndefined();
  });
});
