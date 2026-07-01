import { describe, expect, it } from 'bun:test';

import { toEvent } from './payload';

const base = {
  cwd: '/repo',
  session_id: '00000000-0000-0000-0000-0000000000aa',
};

describe('toEvent permission mode capture', () => {
  it("maps Claude Code's permission_mode into session_context.mode", () => {
    const ev = toEvent('pre-tool-use', {
      ...base,
      permission_mode: 'bypassPermissions',
      tool_name: 'Bash',
    });
    expect(ev.session_context.mode).toBe('bypass');
  });

  it('falls back to normal when no permission_mode is present', () => {
    const ev = toEvent('pre-tool-use', { ...base, tool_name: 'Read' });
    expect(ev.session_context.mode).toBe('normal');
  });

  it('does not duplicate permission_mode into metadata', () => {
    const ev = toEvent('pre-tool-use', {
      ...base,
      permission_mode: 'plan',
      tool_name: 'Read',
    });
    expect(ev.metadata.permission_mode).toBeUndefined();
    expect(ev.session_context.mode).toBe('plan');
  });
});

describe('toEvent notification classification', () => {
  it('derives notification_kind from the structured notification_type', () => {
    const ev = toEvent('notification', {
      ...base,
      message: 'Permission required: Bash command',
      notification_type: 'permission_prompt',
    });
    expect(ev.event_type).toBe('Notification');
    expect(ev.metadata.notification_kind).toBe('permission');
    // raw fields are preserved in metadata for forensics
    expect(ev.metadata.notification_type).toBe('permission_prompt');
  });

  it('classifies idle prompts', () => {
    const ev = toEvent('notification', {
      ...base,
      notification_type: 'idle_prompt',
    });
    expect(ev.metadata.notification_kind).toBe('idle');
  });

  it('does not attach notification_kind to non-notification events', () => {
    const ev = toEvent('post-tool-use', { ...base, tool_name: 'Edit' });
    expect(ev.metadata.notification_kind).toBeUndefined();
  });
});
