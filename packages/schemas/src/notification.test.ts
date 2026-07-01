import { describe, expect, it } from 'vitest';

import { classifyNotification, isBlockingNotification } from './notification';

describe('classifyNotification', () => {
  it("maps Claude Code's structured notification_type", () => {
    expect(classifyNotification('permission_prompt')).toBe('permission');
    expect(classifyNotification('idle_prompt')).toBe('idle');
    expect(classifyNotification('auth_success')).toBe('auth');
    expect(classifyNotification('elicitation_dialog')).toBe('elicitation');
    expect(classifyNotification('elicitation_complete')).toBe('elicitation');
  });

  it('falls back to message text when no structured type is present', () => {
    expect(classifyNotification(undefined, 'Permission required: Bash command')).toBe('permission');
    expect(classifyNotification(undefined, 'Claude is waiting for your input')).toBe('idle');
  });

  it('returns other for unrecognized notifications', () => {
    expect(classifyNotification(undefined, undefined)).toBe('other');
    expect(classifyNotification('something_new', 'a neutral message')).toBe('other');
  });

  it('flags permission, idle, and elicitation as blocking on a human', () => {
    expect(isBlockingNotification('permission')).toBe(true);
    expect(isBlockingNotification('idle')).toBe(true);
    expect(isBlockingNotification('elicitation')).toBe(true);
    expect(isBlockingNotification('auth')).toBe(false);
    expect(isBlockingNotification('other')).toBe(false);
  });
});
