import type { AgentTypeKey } from './agent-registry';

/**
 * The tool-category taxonomy declared in `DESIGN_DOC.md` §5.3. This is the only
 * place it is spelled out in code — `tool-category.test.ts` pins this exact list
 * so the design doc, the wire schema, and the adapters cannot drift apart again
 * (which is exactly how the hook ended up emitting only 'builtin'/'mcp' — a
 * taxonomy that existed in prose but nowhere any producer could import).
 */
export const TOOL_CATEGORIES = [
  'fs_read',
  'fs_write',
  'exec',
  'search',
  'web',
  'task',
  'mcp',
  'other',
] as const;

export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

type CategoryMap = Readonly<Record<string, ToolCategory>>;

// Per-agent tool-name → category tables. Keys are each agent's OWN spelling and
// casing — Claude Code is PascalCase, the rest are lowercase/snake_case — because
// that is what `tool_name` carries on the wire; there is no shared vocabulary to
// normalize onto. Sourced from each adapter's own test fixtures (the ids and
// spellings the agent actually emits, per apps/hook/AGENTS.md) plus each agent's
// publicly documented tool set where the fixtures don't cover a name. A name not
// listed here — including every agent with no shipped adapter (AIDER, CURSOR,
// WINDSURF) — falls back to 'other' in `toolCategory()`, never throws.

// Claude Code. Verified against apps/hook/src/adapters/claude-code*.test.ts and
// lib/queue.test.ts fixtures (Bash, Read, Edit, Skill, Task); the rest are
// Claude Code's documented tool surface.
const CLAUDE_CODE_TOOLS: CategoryMap = {
  Bash: 'exec',
  BashOutput: 'exec',
  Edit: 'fs_write',
  ExitPlanMode: 'other',
  Glob: 'search',
  Grep: 'search',
  KillBash: 'exec',
  KillShell: 'exec',
  LS: 'fs_read',
  MultiEdit: 'fs_write',
  NotebookEdit: 'fs_write',
  Read: 'fs_read',
  Skill: 'other',
  SlashCommand: 'other',
  Task: 'task',
  TodoWrite: 'other',
  WebFetch: 'web',
  WebSearch: 'web',
  Write: 'fs_write',
};

// OpenAI Codex CLI. `shell` / `apply_patch` are pinned by
// apps/hook/src/adapters/codex.test.ts; `update_plan`, `view_image`, `web_search`
// are Codex's other documented native tools.
const CODEX_TOOLS: CategoryMap = {
  apply_patch: 'fs_write',
  shell: 'exec',
  update_plan: 'other',
  view_image: 'fs_read',
  web_search: 'web',
};

// Gemini CLI. `read_file` is pinned by
// apps/hook/src/adapters/gemini-cli.test.ts; the rest are Gemini CLI's documented
// core tools (docs/tools/*.md upstream).
const GEMINI_CLI_TOOLS: CategoryMap = {
  activate_skill: 'other',
  ask_user: 'other',
  glob: 'search',
  google_web_search: 'web',
  grep_search: 'search',
  list_directory: 'fs_read',
  read_file: 'fs_read',
  read_many_files: 'fs_read',
  replace: 'fs_write',
  run_shell_command: 'exec',
  save_memory: 'other',
  search_file_content: 'search',
  web_fetch: 'web',
  write_file: 'fs_write',
  write_todos: 'other',
};

// GitHub Copilot CLI. `bash` is pinned by
// apps/hook/src/adapters/copilot.test.ts; `view`/`apply_patch`/`glob`/`rg`/`task`
// are Copilot CLI's other documented built-ins (always present, per its own
// plugin reference docs); `write`/`url` are documented tool *kinds* included
// defensively.
const COPILOT_TOOLS: CategoryMap = {
  apply_patch: 'fs_write',
  bash: 'exec',
  glob: 'search',
  rg: 'search',
  task: 'task',
  url: 'web',
  view: 'fs_read',
  write: 'fs_write',
};

// opencode. apps/hook/src/adapters/opencode.ts's own doc comment: "opencode tool
// names are bare (`bash`, `edit`, `read`) or `<provider>_<tool>` for plugins" —
// the rest are opencode's other documented built-ins.
const OPENCODE_TOOLS: CategoryMap = {
  bash: 'exec',
  edit: 'fs_write',
  glob: 'search',
  grep: 'search',
  list: 'fs_read',
  lsp: 'other',
  patch: 'fs_write',
  question: 'other',
  read: 'fs_read',
  skill: 'other',
  task: 'task',
  todoread: 'other',
  todowrite: 'other',
  webfetch: 'web',
  write: 'fs_write',
};

// Pi. Pi ships exactly four built-in tools — read, write, edit, bash (its own
// docs; `bash` is also pinned by apps/hook/src/adapters/pi.test.ts).
const PI_TOOLS: CategoryMap = {
  bash: 'exec',
  edit: 'fs_write',
  read: 'fs_read',
  write: 'fs_write',
};

// omp. A Pi fork sharing Pi's core vocabulary (`edit` is pinned by
// apps/hook/src/adapters/omp.test.ts) plus its own subagent/task tool. omp ships
// ~32 built-ins in total (LSP/DAP among them) that are not individually
// confirmed against a real session — unmapped names fall back to 'other' rather
// than guessing.
const OMP_TOOLS: CategoryMap = {
  bash: 'exec',
  edit: 'fs_write',
  read: 'fs_read',
  task: 'task',
  write: 'fs_write',
};

const TOOL_CATEGORY_MAPS: Readonly<Partial<Record<AgentTypeKey, CategoryMap>>> = {
  CLAUDE_CODE: CLAUDE_CODE_TOOLS,
  CODEX: CODEX_TOOLS,
  COPILOT: COPILOT_TOOLS,
  GEMINI_CLI: GEMINI_CLI_TOOLS,
  OMP: OMP_TOOLS,
  OPENCODE: OPENCODE_TOOLS,
  PI: PI_TOOLS,
};

/**
 * Classify a tool call into the DESIGN_DOC §5.3 taxonomy (P14-002). O(1): a
 * truthy check plus up to two hash lookups — no regex, no scanning — so it is
 * safe on the hook's <10 ms hot path (`apps/hook/AGENTS.md`).
 *
 * MCP wins first. Every adapter already detects "is this an MCP call" its own
 * way — the `mcp__` prefix for Claude Code/Codex/the stdin-hook factory
 * (including the `mcp__server`-with-no-tool-segment edge case, where the parsed
 * server name is null but the call is still MCP), Gemini's `mcp_context` field,
 * Pi/OMP's looser "contains `__` anywhere" rule. Callers pass that already-
 * resolved signal through as `mcp` rather than this function re-deriving it, so
 * each adapter's existing detection is preserved exactly as-is.
 *
 * Anything else falls back to the per-agent tool-name table above. An unmapped
 * name — including every tool of an agent with no shipped adapter (AIDER,
 * CURSOR, WINDSURF) — becomes 'other' rather than throwing, per the hook's
 * always-exit-0 rule.
 */
export function toolCategory(
  agentType: string,
  toolName: string | null | undefined,
  mcp?: string | boolean | null,
): ToolCategory {
  if (mcp) {
    return 'mcp';
  }
  if (!toolName) {
    return 'other';
  }
  return TOOL_CATEGORY_MAPS[agentType as AgentTypeKey]?.[toolName] ?? 'other';
}
