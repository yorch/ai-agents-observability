export const EVENTS_API_VERSION = '1' as const;

export { agentDisplayName, DEFAULT_AGENT_TYPE, multiAgentLabels } from './agent-display';
export type { AlertRuleType, AlertSeverity } from './alerts';
export {
  BUDGET_THRESHOLD_CRITICAL_RATIO,
  BUDGET_THRESHOLD_WARN_RATIO,
  BUDGET_THRESHOLD_WINDOW_DAYS,
  ERROR_RATE_CRITICAL,
  ERROR_RATE_MIN_CALLS,
  ERROR_RATE_WARN,
  ERROR_RATE_WINDOW_DAYS,
  SPEND_SPIKE_BASELINE_DAYS,
  SPEND_SPIKE_CRITICAL_SIGMA,
  SPEND_SPIKE_WARN_SIGMA,
  SPEND_SPIKE_WINDOW_DAYS,
  UNKNOWN_MODEL_SURGE_DEFAULT,
  UNKNOWN_MODEL_WINDOW_HOURS,
} from './alerts';
export type {
  FrictionComponents,
  FrictionInputs,
  ShapeLabel,
  ToolHistogram,
} from './effectiveness';
export {
  classifySessionShape,
  computeFrictionScore,
  EXEC_TOOLS,
  FRICTION_VERSION,
  FRICTION_WEIGHTS,
  frictionComponents,
  READ_TOOLS,
  WRITE_TOOLS,
} from './effectiveness';
export type {
  AgentType,
  Event,
  EventsBatch,
  EventsBatchEnvelope,
  EventType,
  ToolInfo,
} from './event';
export {
  AgentTypeSchema,
  EventSchema,
  EventsBatchEnvelopeSchema,
  EventsBatchSchema,
  EventTypeSchema,
} from './event';
export type { ModelPrice, PriceTable } from './price-table';
export { PriceTableSchema } from './price-table';
export type { RepoConfig } from './repo-config';
export { parseRepoConfig, RepoConfigSchema } from './repo-config';
export type { GitContext, SessionContext } from './session-context';
export { GitContextSchema, SessionContextSchema } from './session-context';
export type { TranscriptChunkMeta } from './transcript';
export { TranscriptChunkMetaSchema } from './transcript';
