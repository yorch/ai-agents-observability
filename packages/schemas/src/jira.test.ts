import { describe, expect, it } from 'vitest';

import { extractJiraKey, extractJiraKeyFromSources } from './jira';

describe('extractJiraKey', () => {
  it('extracts the first Jira key from a branch name', () => {
    expect(extractJiraKey('feature/OBS-42-add-widget')).toBe('OBS-42');
  });

  it('supports project keys with digits', () => {
    expect(extractJiraKey('ABC1-999/fix')).toBe('ABC1-999');
  });

  it('extracts from titles and prose', () => {
    expect(extractJiraKey('OBS-7: fix the flusher')).toBe('OBS-7');
    expect(extractJiraKey('Implements PROJ-88 as discussed')).toBe('PROJ-88');
  });

  it('returns null when no Jira key is present', () => {
    expect(extractJiraKey('feature/no-ticket')).toBeNull();
    expect(extractJiraKey('')).toBeNull();
  });
});

describe('extractJiraKeyFromSources', () => {
  it('takes the first source that yields a key, in order', () => {
    expect(extractJiraKeyFromSources('feature/no-ticket', 'OBS-1: title', 'body with OBS-2')).toBe(
      'OBS-1',
    );
  });

  it('skips null and undefined sources', () => {
    expect(extractJiraKeyFromSources(null, undefined, 'feat/JIRA-1234')).toBe('JIRA-1234');
  });

  it('returns null when no source has a key', () => {
    expect(extractJiraKeyFromSources('main', null, 'no keys here')).toBeNull();
  });
});
