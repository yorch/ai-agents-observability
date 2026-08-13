// The single source of truth for which coding agents exist and how they are named
// (P12-001). Everything agent-shaped derives from this table:
//
//   - `AgentTypeSchema` (event.ts) — the wire enum
//   - `agentDisplayName()` (agent-display.ts) — user-facing labels
//   - `/admin/adapters` — which agents get a first-class row
//
// The Prisma `AgentType` enum must hold the same values; `agent-registry.test.ts`
// asserts that, so a half-landed widening fails a test rather than surfacing as a
// runtime insert error months later.
//
// Adding an agent = one entry here + the Prisma enum + (if `hasAdapter`) an adapter
// in apps/hook and a price table in apps/ingest.

export type AgentDefinition = {
  /**
   * True when `apps/hook` ships a capture adapter for this agent — i.e. we can
   * actually receive its telemetry. False entries are accepted-but-unimplemented:
   * the enum value exists so an event carrying it validates, but nothing produces
   * one yet.
   */
  hasAdapter: boolean;
  /** Human-readable label. Matches the project's own styling of its name. */
  label: string;
};

export const AGENT_REGISTRY = {
  AIDER: { hasAdapter: false, label: 'Aider' },
  CLAUDE_CODE: { hasAdapter: true, label: 'Claude Code' },
  CODEX: { hasAdapter: true, label: 'Codex' },
  COPILOT: { hasAdapter: true, label: 'Copilot' },
  CURSOR: { hasAdapter: false, label: 'Cursor' },
  GEMINI_CLI: { hasAdapter: true, label: 'Gemini CLI' },
  // Both projects lowercase their own names; match them rather than title-casing.
  OMP: { hasAdapter: true, label: 'omp' },
  OPENCODE: { hasAdapter: true, label: 'opencode' },
  PI: { hasAdapter: true, label: 'Pi' },
  WINDSURF: { hasAdapter: false, label: 'Windsurf' },
} as const satisfies Record<string, AgentDefinition>;

export type AgentTypeKey = keyof typeof AGENT_REGISTRY;

// z.enum() needs a non-empty tuple; the registry is a non-empty literal, so the
// assertion is safe and keeps the enum from drifting out of sync with the table.
export const AGENT_TYPES = Object.keys(AGENT_REGISTRY) as [AgentTypeKey, ...AgentTypeKey[]];

/** Agents with a shipped capture adapter, sorted — the `/admin/adapters` rows. */
export const ADAPTER_AGENT_TYPES: AgentTypeKey[] = AGENT_TYPES.filter(
  (key) => AGENT_REGISTRY[key].hasAdapter,
);
