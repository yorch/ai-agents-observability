import { describe, expect, it } from 'bun:test';
import type { GitContext } from '@ai-agents-observability/schemas';

import { enrichGitContext } from '../src/flusher';

function makeEvent(cwd: string, git: GitContext | null = null): Record<string, unknown> {
  return {
    agent_type: 'claude-code',
    event_id: '01906a44-0000-7000-8000-000000000001',
    event_type: 'PostToolUse',
    session_context: { cwd, git, is_resume: false, mode: 'normal' },
    session_id: '01906a44-0000-7000-8000-000000000000',
  };
}

const GIT: GitContext = {
  branch: 'main',
  commit: 'abc123',
  is_dirty: false,
  owner: 'acme',
  pr_number: null,
  remote_url: 'git@github.com:acme/widget.git',
  repo: 'widget',
};

describe('enrichGitContext', () => {
  it('fills git context for events captured without it', () => {
    const events = [makeEvent('/repo')];
    enrichGitContext(events, () => GIT);
    expect((events[0] as { session_context: { git: GitContext } }).session_context.git).toEqual(
      GIT,
    );
  });

  it('resolves each distinct cwd only once (caches within a batch)', () => {
    const events = [makeEvent('/repo'), makeEvent('/repo'), makeEvent('/other')];
    const seen: string[] = [];
    enrichGitContext(events, (cwd) => {
      seen.push(cwd);
      return GIT;
    });
    expect(seen).toEqual(['/repo', '/other']);
  });

  it('never overwrites git context that is already present', () => {
    const existing: GitContext = { ...GIT, branch: 'feature' };
    const events = [makeEvent('/repo', existing)];
    enrichGitContext(events, () => GIT);
    expect((events[0] as { session_context: { git: GitContext } }).session_context.git.branch).toBe(
      'feature',
    );
  });

  it('leaves git null when the resolver returns null (non-repo cwd)', () => {
    const events = [makeEvent('/tmp')];
    enrichGitContext(events, () => null);
    expect(
      (events[0] as { session_context: { git: GitContext | null } }).session_context.git,
    ).toBeNull();
  });
});
