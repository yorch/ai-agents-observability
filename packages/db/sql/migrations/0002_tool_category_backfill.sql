-- Backfill tool_category for events ingested before P14-002. Every producer
-- (apps/hook's adapters) wrote a flat 'builtin' or 'mcp' instead of the real
-- DESIGN_DOC.md §5.3 taxonomy (fs_read/fs_write/exec/search/web/task/mcp/
-- other) — see packages/schemas/src/tool-category.ts (toolCategory()), which
-- every producer now calls at capture time. New events already carry the real
-- category, so this reclassifies rows already on disk from
-- (agent_type, tool_name, mcp_server) instead, to match.
--
-- Mirrors toolCategory()'s per-agent tool-name tables as of this file's
-- authorship. SQL cannot import that TS source of truth, so the two are kept
-- in sync by hand — tool-category.test.ts pins the taxonomy values themselves
-- (fs_read/fs_write/exec/search/web/task/mcp/other), so a drift here shows up
-- as a diff against that file on review, not a silent divergence.
--
-- 0003_ is reserved for a sibling change in flight — this file is 0002_ only.

UPDATE events SET tool_category = CASE
  -- MCP wins first, exactly as toolCategory() does: a resolved mcp_server, or
  -- the mcp__ prefix alone (covers the mcp__server-with-no-tool-segment edge
  -- case, where mcp_server was never parsed but the call is still MCP).
  WHEN mcp_server IS NOT NULL THEN 'mcp'
  WHEN left(tool_name, 5) = 'mcp__' THEN 'mcp'

  WHEN agent_type = 'CLAUDE_CODE' THEN CASE tool_name
    WHEN 'Bash' THEN 'exec'
    WHEN 'BashOutput' THEN 'exec'
    WHEN 'KillBash' THEN 'exec'
    WHEN 'KillShell' THEN 'exec'
    WHEN 'Read' THEN 'fs_read'
    WHEN 'LS' THEN 'fs_read'
    WHEN 'Edit' THEN 'fs_write'
    WHEN 'Write' THEN 'fs_write'
    WHEN 'MultiEdit' THEN 'fs_write'
    WHEN 'NotebookEdit' THEN 'fs_write'
    WHEN 'Grep' THEN 'search'
    WHEN 'Glob' THEN 'search'
    WHEN 'WebFetch' THEN 'web'
    WHEN 'WebSearch' THEN 'web'
    WHEN 'Task' THEN 'task'
    -- Pre-P14-002 seed data used the fictional tool_name 'Agent' for subagent
    -- spawns (packages/db/src/seed.ts now seeds the real name, 'Task') —
    -- reclassify any such rows already on disk the same way.
    WHEN 'Agent' THEN 'task'
    WHEN 'Skill' THEN 'other'
    WHEN 'SlashCommand' THEN 'other'
    WHEN 'TodoWrite' THEN 'other'
    WHEN 'ExitPlanMode' THEN 'other'
    ELSE 'other'
  END

  WHEN agent_type = 'CODEX' THEN CASE tool_name
    WHEN 'shell' THEN 'exec'
    WHEN 'apply_patch' THEN 'fs_write'
    WHEN 'view_image' THEN 'fs_read'
    WHEN 'web_search' THEN 'web'
    WHEN 'update_plan' THEN 'other'
    ELSE 'other'
  END

  WHEN agent_type = 'GEMINI_CLI' THEN CASE tool_name
    WHEN 'read_file' THEN 'fs_read'
    WHEN 'read_many_files' THEN 'fs_read'
    WHEN 'list_directory' THEN 'fs_read'
    WHEN 'write_file' THEN 'fs_write'
    WHEN 'replace' THEN 'fs_write'
    WHEN 'glob' THEN 'search'
    WHEN 'search_file_content' THEN 'search'
    WHEN 'grep_search' THEN 'search'
    WHEN 'run_shell_command' THEN 'exec'
    WHEN 'google_web_search' THEN 'web'
    WHEN 'web_fetch' THEN 'web'
    WHEN 'save_memory' THEN 'other'
    WHEN 'write_todos' THEN 'other'
    WHEN 'ask_user' THEN 'other'
    WHEN 'activate_skill' THEN 'other'
    ELSE 'other'
  END

  WHEN agent_type = 'COPILOT' THEN CASE tool_name
    WHEN 'bash' THEN 'exec'
    WHEN 'view' THEN 'fs_read'
    WHEN 'apply_patch' THEN 'fs_write'
    WHEN 'write' THEN 'fs_write'
    WHEN 'glob' THEN 'search'
    WHEN 'rg' THEN 'search'
    WHEN 'task' THEN 'task'
    WHEN 'url' THEN 'web'
    ELSE 'other'
  END

  WHEN agent_type = 'OPENCODE' THEN CASE tool_name
    WHEN 'bash' THEN 'exec'
    WHEN 'read' THEN 'fs_read'
    WHEN 'list' THEN 'fs_read'
    WHEN 'edit' THEN 'fs_write'
    WHEN 'write' THEN 'fs_write'
    WHEN 'patch' THEN 'fs_write'
    WHEN 'grep' THEN 'search'
    WHEN 'glob' THEN 'search'
    WHEN 'webfetch' THEN 'web'
    WHEN 'task' THEN 'task'
    WHEN 'lsp' THEN 'other'
    WHEN 'todowrite' THEN 'other'
    WHEN 'todoread' THEN 'other'
    WHEN 'skill' THEN 'other'
    WHEN 'question' THEN 'other'
    ELSE 'other'
  END

  WHEN agent_type = 'PI' THEN CASE tool_name
    WHEN 'bash' THEN 'exec'
    WHEN 'read' THEN 'fs_read'
    WHEN 'write' THEN 'fs_write'
    WHEN 'edit' THEN 'fs_write'
    ELSE 'other'
  END

  WHEN agent_type = 'OMP' THEN CASE tool_name
    WHEN 'bash' THEN 'exec'
    WHEN 'read' THEN 'fs_read'
    WHEN 'write' THEN 'fs_write'
    WHEN 'edit' THEN 'fs_write'
    WHEN 'task' THEN 'task'
    ELSE 'other'
  END

  ELSE 'other'
END
WHERE event_type = 'PostToolUse' AND tool_name IS NOT NULL;
