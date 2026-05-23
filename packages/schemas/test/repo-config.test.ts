import { describe, expect, it } from 'vitest';

import { parseRepoConfig } from '../src/repo-config';

describe('parseRepoConfig', () => {
  it('valid minimal: "version: 1" returns config with pr_bot.enabled = false', () => {
    const result = parseRepoConfig('version: 1');
    expect(result).not.toBeNull();
    expect(result?.pr_bot.enabled).toBe(false);
  });

  it('valid full file with all fields set', () => {
    const yaml = `
version: 1
pr_bot:
  enabled: true
  include_cost: false
  include_tool_counts: false
  include_contributors: false
`;
    const result = parseRepoConfig(yaml);
    expect(result).not.toBeNull();
    expect(result?.pr_bot.enabled).toBe(true);
    expect(result?.pr_bot.include_cost).toBe(false);
    expect(result?.pr_bot.include_tool_counts).toBe(false);
    expect(result?.pr_bot.include_contributors).toBe(false);
  });

  it('enabled: true in pr_bot parses correctly', () => {
    const yaml = `
version: 1
pr_bot:
  enabled: true
`;
    const result = parseRepoConfig(yaml);
    expect(result).not.toBeNull();
    expect(result?.pr_bot.enabled).toBe(true);
  });

  it('invalid YAML returns null', () => {
    const result = parseRepoConfig('version: : bad');
    expect(result).toBeNull();
  });

  it('wrong version (version: 2) returns null', () => {
    const result = parseRepoConfig('version: 2');
    expect(result).toBeNull();
  });

  it('empty string returns null', () => {
    const result = parseRepoConfig('');
    expect(result).toBeNull();
  });

  it('extra unknown keys are parsed (stripped, not error)', () => {
    const yaml = `
version: 1
some_unknown_key: foobar
pr_bot:
  enabled: false
  unknown_pr_key: hello
`;
    const result = parseRepoConfig(yaml);
    expect(result).not.toBeNull();
    expect(result?.pr_bot.enabled).toBe(false);
  });

  it('pr_bot.enabled: false explicitly does NOT return null; returns config with enabled=false', () => {
    const yaml = `
version: 1
pr_bot:
  enabled: false
`;
    const result = parseRepoConfig(yaml);
    expect(result).not.toBeNull();
    expect(result?.pr_bot.enabled).toBe(false);
  });
});
