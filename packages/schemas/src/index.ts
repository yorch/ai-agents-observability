export const EVENTS_API_VERSION = '1' as const;

export { agentDisplayName, DEFAULT_AGENT_TYPE, multiAgentLabels } from './agent-display';
export type { AlertRuleType, AlertSeverity, BudgetThresholdParams } from './alerts';
export {
  AUTONOMY_SURGE_CRITICAL,
  AUTONOMY_SURGE_MIN_SESSIONS,
  AUTONOMY_SURGE_WARN,
  AUTONOMY_SURGE_WINDOW_DAYS,
  BUDGET_THRESHOLD_CRITICAL_RATIO,
  BUDGET_THRESHOLD_WARN_RATIO,
  BUDGET_THRESHOLD_WINDOW_DAYS,
  BudgetThresholdParamsSchema,
  ERROR_RATE_CRITICAL,
  ERROR_RATE_MIN_CALLS,
  ERROR_RATE_WARN,
  ERROR_RATE_WINDOW_DAYS,
  parseBudgetThresholdParams,
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
  frictionScoreFromComponents,
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
export { extractJiraKey, extractJiraKeyFromSources } from './jira';
export type { NotificationKind } from './notification';
export {
  BLOCKING_NOTIFICATION_KINDS,
  classifyNotification,
  isBlockingNotification,
  NOTIFICATION_KINDS,
} from './notification';
export type { ModelPrice, PriceTable } from './price-table';
export { PriceTableSchema } from './price-table';
export type { RepoConfig } from './repo-config';
export { parseRepoConfig, RepoConfigSchema } from './repo-config';
export type { GitContext, PermissionMode, SessionContext } from './session-context';
export {
  AUTONOMY_RANK,
  canonicalPermissionMode,
  GitContextSchema,
  isLowOversightMode,
  LOW_OVERSIGHT_MODES,
  PERMISSION_MODES,
  SessionContextSchema,
} from './session-context';
export type { TranscriptChunkMeta } from './transcript';
export { TranscriptChunkMetaSchema } from './transcript';
