import { describe, expect, it } from 'vitest';

import { ADAPTER_AGENT_TYPES } from './agent-registry';
import { TOOL_CATEGORIES, toolCategory } from './tool-category';

// Pins the taxonomy union itself (P14-002) so DESIGN_DOC.md §5.3, the wire
// schema, and this code cannot silently drift apart again — which is exactly how
// the hook ended up emitting only 'builtin'/'mcp' while the design doc, unread by
// any producer, said something else entirely.
describe('TOOL_CATEGORIES', () => {
  it('matches DESIGN_DOC.md §5.3 exactly', () => {
    expect(TOOL_CATEGORIES).toEqual([
      'fs_read',
      'fs_write',
      'exec',
      'search',
      'web',
      'task',
      'mcp',
      'other',
    ]);
  });
});

describe('toolCategory — MCP detection', () => {
  it('wins over any per-agent mapping when a resolved server name is passed', () => {
    expect(toolCategory('CLAUDE_CODE', 'Bash', 'github')).toBe('mcp');
  });

  it('wins on a bare boolean signal (the mcp__server-with-no-tool-segment edge case)', () => {
    // payload.ts categorizes by the isMcp boolean, not the parsed server name,
    // because `mcp__server` (no further `__`) still fails to parse a server but
    // is still an MCP call. Callers reproduce that by passing `true` here rather
    // than a resolved (and in that case null) server string.
    expect(toolCategory('CLAUDE_CODE', 'mcp__server', true)).toBe('mcp');
  });

  it('does not trigger on a falsy signal', () => {
    expect(toolCategory('CLAUDE_CODE', 'Bash', null)).toBe('exec');
    expect(toolCategory('CLAUDE_CODE', 'Bash', undefined)).toBe('exec');
    expect(toolCategory('CLAUDE_CODE', 'Bash', false)).toBe('exec');
    expect(toolCategory('CLAUDE_CODE', 'Bash', '')).toBe('exec');
  });
});

describe('toolCategory — unknown input never throws', () => {
  it('falls back to other for an unrecognized tool name', () => {
    expect(toolCategory('CLAUDE_CODE', 'SomeFutureTool')).toBe('other');
  });

  it('falls back to other for a null/undefined tool name', () => {
    expect(toolCategory('CLAUDE_CODE', null)).toBe('other');
    expect(toolCategory('CLAUDE_CODE', undefined)).toBe('other');
  });

  it('falls back to other for an agent with no shipped adapter', () => {
    expect(toolCategory('CURSOR', 'anything')).toBe('other');
    expect(toolCategory('AIDER', 'anything')).toBe('other');
    expect(toolCategory('WINDSURF', 'anything')).toBe('other');
  });

  it('falls back to other for a completely unknown agent_type string', () => {
    expect(toolCategory('SOME_FUTURE_AGENT', 'bash')).toBe('other');
  });
});

describe('toolCategory — per-agent mappings', () => {
  it('classifies Claude Code tools', () => {
    expect(toolCategory('CLAUDE_CODE', 'Read')).toBe('fs_read');
    expect(toolCategory('CLAUDE_CODE', 'Edit')).toBe('fs_write');
    expect(toolCategory('CLAUDE_CODE', 'Write')).toBe('fs_write');
    expect(toolCategory('CLAUDE_CODE', 'MultiEdit')).toBe('fs_write');
    expect(toolCategory('CLAUDE_CODE', 'Bash')).toBe('exec');
    expect(toolCategory('CLAUDE_CODE', 'Grep')).toBe('search');
    expect(toolCategory('CLAUDE_CODE', 'Glob')).toBe('search');
    expect(toolCategory('CLAUDE_CODE', 'WebFetch')).toBe('web');
    expect(toolCategory('CLAUDE_CODE', 'WebSearch')).toBe('web');
    expect(toolCategory('CLAUDE_CODE', 'Task')).toBe('task');
    expect(toolCategory('CLAUDE_CODE', 'Skill')).toBe('other');
  });

  it('classifies Codex tools', () => {
    expect(toolCategory('CODEX', 'shell')).toBe('exec');
    expect(toolCategory('CODEX', 'apply_patch')).toBe('fs_write');
    expect(toolCategory('CODEX', 'update_plan')).toBe('other');
  });

  it('classifies Gemini CLI tools', () => {
    expect(toolCategory('GEMINI_CLI', 'read_file')).toBe('fs_read');
    expect(toolCategory('GEMINI_CLI', 'write_file')).toBe('fs_write');
    expect(toolCategory('GEMINI_CLI', 'run_shell_command')).toBe('exec');
    expect(toolCategory('GEMINI_CLI', 'glob')).toBe('search');
    expect(toolCategory('GEMINI_CLI', 'google_web_search')).toBe('web');
  });

  it('classifies Copilot CLI tools', () => {
    expect(toolCategory('COPILOT', 'bash')).toBe('exec');
    expect(toolCategory('COPILOT', 'view')).toBe('fs_read');
    expect(toolCategory('COPILOT', 'apply_patch')).toBe('fs_write');
    expect(toolCategory('COPILOT', 'glob')).toBe('search');
    expect(toolCategory('COPILOT', 'task')).toBe('task');
  });

  it('classifies opencode tools', () => {
    expect(toolCategory('OPENCODE', 'bash')).toBe('exec');
    expect(toolCategory('OPENCODE', 'edit')).toBe('fs_write');
    expect(toolCategory('OPENCODE', 'read')).toBe('fs_read');
    expect(toolCategory('OPENCODE', 'grep')).toBe('search');
    expect(toolCategory('OPENCODE', 'webfetch')).toBe('web');
  });

  it('classifies Pi tools', () => {
    expect(toolCategory('PI', 'bash')).toBe('exec');
    expect(toolCategory('PI', 'read')).toBe('fs_read');
    expect(toolCategory('PI', 'write')).toBe('fs_write');
    expect(toolCategory('PI', 'edit')).toBe('fs_write');
  });

  it('classifies omp tools', () => {
    expect(toolCategory('OMP', 'bash')).toBe('exec');
    expect(toolCategory('OMP', 'edit')).toBe('fs_write');
    expect(toolCategory('OMP', 'task')).toBe('task');
  });

  it('never returns a value outside the declared taxonomy, for every adapter agent', () => {
    const sampleNames = ['bash', 'Bash', 'read', 'Read', 'unknown_tool_xyz', 'mcp__server__tool'];
    for (const agentType of ADAPTER_AGENT_TYPES) {
      for (const name of sampleNames) {
        expect(TOOL_CATEGORIES).toContain(toolCategory(agentType, name));
      }
    }
  });
});
