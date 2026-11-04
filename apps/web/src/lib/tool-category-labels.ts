/**
 * Display labels (and a coarse risk tier) for the `tool_category` taxonomy in
 * `@ai-agents-observability/schemas` (`TOOL_CATEGORIES`). One map so /org/tools
 * and /org/security name the same category the same way; the two pages count
 * differently (see their captions) but must not label differently.
 */
export type ToolCategoryMeta = { label: string; risk: 'high' | 'med' | 'low' };

export const TOOL_CATEGORY_META: Record<string, ToolCategoryMeta> = {
  exec: { label: 'Code execution', risk: 'high' },
  fs_read: { label: 'File reads', risk: 'low' },
  fs_write: { label: 'File writes', risk: 'med' },
  mcp: { label: 'MCP calls', risk: 'med' },
  other: { label: 'Other', risk: 'low' },
  search: { label: 'Search', risk: 'low' },
  task: { label: 'Subagent tasks', risk: 'low' },
  web: { label: 'Network / web', risk: 'high' },
};

/** Friendly label for a category key; an unknown key falls back to itself. */
export function toolCategoryLabel(category: string): string {
  return TOOL_CATEGORY_META[category]?.label ?? category;
}
