import type { PriceTable } from '@ai-agents-observability/schemas';
import { PriceTableSchema } from '@ai-agents-observability/schemas';

import rawClaudeCode from '../data/price-table.claude_code.v1.json' with { type: 'json' };
import rawCodex from '../data/price-table.codex.v1.json' with { type: 'json' };
import rawCopilot from '../data/price-table.copilot.v2.json' with { type: 'json' };
import rawGeminiCli from '../data/price-table.gemini_cli.v1.json' with { type: 'json' };
import rawOmp from '../data/price-table.omp.v1.json' with { type: 'json' };
import rawOpencode from '../data/price-table.opencode.v1.json' with { type: 'json' };
import rawPi from '../data/price-table.pi.v1.json' with { type: 'json' };

// Per-agent price tables (P8-002, DESIGN_DOC §11.6). Cost is keyed on
// (agent_type, model): each agent ships its own versioned table so a non-Anthropic
// agent's models price correctly without colliding with Anthropic model names.
// Keep old v<N> files when a table's structure changes so historical events stay
// reproducible against the version they were priced with.
//
// `copilot.v1` is the one deletion (P14-015), and only because there is provably
// nothing to reproduce: it was the empty table, so every event it ever touched
// was priced at exactly $0 by an empty `prices` map. Keeping a file that encodes
// "no prices" would preserve no number the git history does not already hold.

export const DEFAULT_AGENT = 'claude_code';

// agent_type is normalized to underscores on write (insert-events); normalize here
// too so 'claude-code' and 'claude_code' resolve to the same table.
const normalize = (agentType: string): string => agentType.replaceAll('-', '_').toLowerCase();

const tables: Record<string, PriceTable> = {
  claude_code: PriceTableSchema.parse(rawClaudeCode),
  codex: PriceTableSchema.parse(rawCodex),
  copilot: PriceTableSchema.parse(rawCopilot),
  gemini_cli: PriceTableSchema.parse(rawGeminiCli),
  omp: PriceTableSchema.parse(rawOmp),
  opencode: PriceTableSchema.parse(rawOpencode),
  pi: PriceTableSchema.parse(rawPi),
};

// Returned for unknown agents: empty prices, so every model bills $0 and is
// surfaced via unknown_model_events_total rather than being mispriced against
// another agent's table.
const EMPTY_TABLE: PriceTable = {
  generated_at: tables.claude_code?.generated_at ?? '1970-01-01T00:00:00Z',
  prices: {},
  version: 'empty',
};

export type PriceTableRegistry = {
  /** Table to price an event's LLM usage; unknown agents get an empty table. */
  resolve(agentType: string): PriceTable;
  /** Table for GET /v1/price-table; null when the agent param is unknown. */
  forAgentParam(agent: string | undefined): PriceTable | null;
};

/** Every agent whose table ships in this build, for policy resolution. */
export function pricedAgentTypes(): string[] {
  return Object.keys(tables);
}

/** The raw table for one agent, or null. Used to derive model tiers. */
export function priceTableFor(agentType: string): PriceTable | null {
  return tables[normalize(agentType)] ?? null;
}

export function buildPriceTableRegistry(): PriceTableRegistry {
  return {
    forAgentParam(agent: string | undefined): PriceTable | null {
      return tables[normalize(agent ?? DEFAULT_AGENT)] ?? null;
    },
    resolve(agentType: string): PriceTable {
      return tables[normalize(agentType)] ?? EMPTY_TABLE;
    },
  };
}
