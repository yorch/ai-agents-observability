import { describe, expect, it } from 'vitest';

import {
  AUTONOMY_RANK,
  canonicalPermissionMode,
  type PermissionMode,
  SessionContextSchema,
} from './session-context';

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

  it('accepts the widened autonomy modes', () => {
    for (const mode of ['plan', 'accept_edits', 'auto', 'dont_ask', 'bypass'] as const) {
      expect(SessionContextSchema.safeParse({ ...validContext, mode }).success).toBe(true);
    }
  });

  it('rejects invalid PR status values', () => {
    const badContext = {
      ...validContext,
      git: { ...validContext.git, pr_ci_status: 'CANCELLED' },
    };

    expect(SessionContextSchema.safeParse(badContext).success).toBe(false);
  });
});

describe('canonicalPermissionMode', () => {
  it("maps Claude Code's raw permission_mode casing to the canonical enum", () => {
    expect(canonicalPermissionMode('default')).toBe('normal');
    expect(canonicalPermissionMode('plan')).toBe('plan');
    expect(canonicalPermissionMode('acceptEdits')).toBe('accept_edits');
    expect(canonicalPermissionMode('auto')).toBe('auto');
    expect(canonicalPermissionMode('dontAsk')).toBe('dont_ask');
    expect(canonicalPermissionMode('bypassPermissions')).toBe('bypass');
  });

  it('falls back to normal for absent or unknown values', () => {
    expect(canonicalPermissionMode(undefined)).toBe('normal');
    expect(canonicalPermissionMode(null)).toBe('normal');
    expect(canonicalPermissionMode('something-else')).toBe('normal');
    expect(canonicalPermissionMode(42)).toBe('normal');
  });

  it('ranks autonomy from supervised (plan) to least-supervised (bypass)', () => {
    const order: PermissionMode[] = [
      'plan',
      'normal',
      'accept_edits',
      'auto',
      'dont_ask',
      'bypass',
    ];
    for (let i = 1; i < order.length; i += 1) {
      expect(AUTONOMY_RANK[order[i] as PermissionMode]).toBeGreaterThan(
        AUTONOMY_RANK[order[i - 1] as PermissionMode],
      );
    }
  });
});
