import { describe, expect, it } from 'vitest';

import { SessionContextSchema } from './session-context';

describe('SessionContextSchema', () => {
  const validContext = {
    cwd: '/repo',
    git: {
      branch: 'feature/test',
      commit: 'abc123',
      github_login: 'octocat',
      is_dirty: false,
      owner: 'acme',
      pr_ci_status: 'SUCCESS',
      pr_number: 12,
      pr_review_decision: 'APPROVED',
      remote_url: 'git@github.com:acme/repo.git',
      repo: 'repo',
      team: 'Platform',
    },
    is_resume: false,
    mode: 'normal',
    project_name: 'repo',
  };

  it('accepts enriched git context fields emitted by the hook flusher', () => {
    expect(SessionContextSchema.safeParse(validContext).success).toBe(true);
  });

  it('keeps enriched git fields optional for older events', () => {
    const legacyContext = {
      ...validContext,
      git: {
        branch: 'main',
        commit: null,
        is_dirty: false,
        owner: null,
        pr_number: null,
        remote_url: null,
        repo: null,
      },
    };

    expect(SessionContextSchema.safeParse(legacyContext).success).toBe(true);
  });

  it('rejects unknown session modes', () => {
    expect(SessionContextSchema.safeParse({ ...validContext, mode: 'review' }).success).toBe(false);
  });

  it('rejects invalid PR status values', () => {
    const badContext = {
      ...validContext,
      git: { ...validContext.git, pr_ci_status: 'CANCELLED' },
    };

    expect(SessionContextSchema.safeParse(badContext).success).toBe(false);
  });
});
