import { Prisma } from '@ai-agents-observability/db';
import type { Event, GitContext } from '@ai-agents-observability/schemas';

import { computeCostUsd } from './cost';
import type { PriceTableRegistry } from './price-tables';

type RawDb = {
  $executeRaw: (query: Prisma.Sql) => Promise<number>;
};

type SessionAgg = {
  agentType: string;
  claudeCodeVersion: string | null;
  clearCount: number;
  compactionCount: number;
  cwd: string;
  endedAt: Date | null;
  firstTs: Date;
  gitBranch: string | null;
  gitCommit: string | null;
  githubLogin: string | null;
  githubTeam: string | null;
  gitIsDirty: boolean | null;
  gitRemoteUrl: string | null;
  hostHash: string | null;
  interruptCount: number;
  isResume: boolean;
  lastTs: Date;
  os: string | null;
  permissionDenyCount: number;
  permissionPromptCount: number;
  githubLogin: string | null;
  githubTeam: string | null;
  prCiStatus: string | null;
  primaryModel: string | null;
  prNumber: number | null;
  projectName: string | null;
  prReviewDecision: string | null;
  repoId: string | null;
  sessionId: string;
  toolCallCount: number;
  toolErrorCount: number;
  totalCacheCreation: number;
  totalCacheRead: number;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  userId: string;
  userMessageCount: number;
};

function emptyAgg(sessionId: string, userId: string, event: Event): SessionAgg {
  const ts = new Date(event.ts);
  return {
    agentType: event.agent_type,
    claudeCodeVersion: event.client.claude_code_version,
    clearCount: 0,
    compactionCount: 0,
    cwd: event.session_context.cwd,
    endedAt: null,
    firstTs: ts,
    gitBranch: event.session_context.git?.branch ?? null,
    gitCommit: event.session_context.git?.commit ?? null,
    githubLogin: event.session_context.git?.github_login ?? null,
    githubTeam: event.session_context.git?.team ?? null,
    gitIsDirty: event.session_context.git?.is_dirty ?? null,
    gitRemoteUrl: event.session_context.git?.remote_url ?? null,
    hostHash: event.client.hostname_hash,
    interruptCount: 0,
    isResume: event.session_context.is_resume,
    lastTs: ts,
    os: event.client.os,
    permissionDenyCount: 0,
    permissionPromptCount: 0,
    prCiStatus: event.session_context.git?.pr_ci_status ?? null,
    primaryModel: null,
    prNumber: event.session_context.git?.pr_number ?? null,
    projectName: event.session_context.project_name ?? null,
    prReviewDecision: event.session_context.git?.pr_review_decision ?? null,
    repoId: null,
    sessionId,
    toolCallCount: 0,
    toolErrorCount: 0,
    totalCacheCreation: 0,
    totalCacheRead: 0,
    totalCostUsd: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    userId,
    userMessageCount: 0,
  };
}

function isEndEvent(eventType: Event['event_type']): boolean {
  return eventType === 'Stop' || eventType === 'SessionEnd' || eventType === 'SubagentStop';
}

function applyEvent(agg: SessionAgg, event: Event, priceTables: PriceTableRegistry): void {
  const ts = new Date(event.ts);
  if (ts.getTime() > agg.lastTs.getTime()) {
    agg.lastTs = ts;
  }
  if (ts.getTime() < agg.firstTs.getTime()) {
    agg.firstTs = ts;
  }

  if (event.llm) {
    agg.totalInputTokens += event.llm.input_tokens;
    agg.totalOutputTokens += event.llm.output_tokens;
    agg.totalCacheRead += event.llm.cache_read_tokens;
    agg.totalCacheCreation += event.llm.cache_creation_tokens;
    agg.totalCostUsd += computeCostUsd(
      event.llm.model,
      event.llm.input_tokens,
      event.llm.output_tokens,
      event.llm.cache_read_tokens,
      event.llm.cache_creation_tokens,
      priceTables.resolve(event.agent_type),
      undefined,
      event.agent_type,
    );
    if (!agg.primaryModel) {
      agg.primaryModel = event.llm.model;
    }
  }

  if (event.event_type === 'PostToolUse' && event.tool) {
    agg.toolCallCount += 1;
    if (event.tool.exit_status !== null && event.tool.exit_status !== 0) {
      agg.toolErrorCount += 1;
    }
    if (event.tool.was_denied) {
      agg.permissionDenyCount += 1;
    }
    if (event.tool.was_interrupted) {
      agg.interruptCount += 1;
    }
  }

  if (event.event_type === 'UserPromptSubmit') {
    agg.userMessageCount += 1;
  }

  if (event.event_type === 'PreCompact') {
    agg.compactionCount += 1;
  }

  if (isEndEvent(event.event_type) && !agg.endedAt) {
    agg.endedAt = ts;
  }
}

export type UpsertResult = { sessionsTouched: number };

// Atomically upserts session rows for every distinct session_id in the batch.
// On conflict, accumulates totals via `col = sessions.col + EXCLUDED.col` —
// concurrency-safe without explicit locks (see DESIGN_DOC §8.2).
export async function upsertSessions(
  db: RawDb,
  events: Event[],
  userId: string,
  repoIdByKey: Map<string, string>,
  priceTables: PriceTableRegistry,
  envelopeGit: GitContext | null = null,
): Promise<UpsertResult> {
  if (events.length === 0) {
    return { sessionsTouched: 0 };
  }

  const bySession = new Map<string, SessionAgg>();
  for (const ev of events) {
    let agg = bySession.get(ev.session_id);
    if (!agg) {
      agg = emptyAgg(ev.session_id, userId, ev);
      // Fall back to the batch envelope's git context when an individual
      // event has none — early SessionStart events often capture before cwd
      // git resolution, but events.ts has already upserted the Repo row
      // (and registered it in repoIdByKey) from the envelope.
      const git = ev.session_context.git ?? envelopeGit;
      if (git?.owner && git?.repo) {
        agg.repoId = repoIdByKey.get(`${git.owner}/${git.repo}`) ?? null;
        if (!agg.gitBranch && git.branch) {
          agg.gitBranch = git.branch;
        }
        if (!agg.gitCommit && git.commit) {
          agg.gitCommit = git.commit;
        }
        if (!agg.gitRemoteUrl && git.remote_url) {
          agg.gitRemoteUrl = git.remote_url;
        }
        if (agg.gitIsDirty === null) {
          agg.gitIsDirty = git.is_dirty;
        }
        if (!agg.prNumber && git.pr_number !== null) {
          agg.prNumber = git.pr_number;
        }
      }
      bySession.set(ev.session_id, agg);
    }
    applyEvent(agg, ev, priceTables);
  }

  const rows = Array.from(bySession.values()).map(
    (a) => Prisma.sql`(
      ${a.sessionId}::uuid,
      ${a.userId}::uuid,
      ${a.agentType}::"AgentType",
      ${a.firstTs},
      ${a.lastTs},
      ${a.endedAt},
      ${a.endedAt ? 'COMPLETED' : 'ACTIVE'}::"SessionStatus",
      ${a.isResume},
      ${a.compactionCount},
      ${a.clearCount},
      ${a.hostHash},
      ${a.claudeCodeVersion},
      ${a.os},
      ${a.cwd},
      ${a.repoId}::uuid,
      ${a.gitBranch},
      ${a.gitCommit},
      ${a.gitRemoteUrl},
      ${a.gitIsDirty},
      ${a.prNumber},
      ${a.prCiStatus},
      ${a.prReviewDecision},
      ${a.githubLogin},
      ${a.githubTeam},
      ${a.projectName},
      ${a.totalInputTokens},
      ${a.totalOutputTokens},
      ${a.totalCacheRead},
      ${a.totalCacheCreation},
      ${a.totalCostUsd},
      ${a.toolCallCount},
      ${a.toolErrorCount},
      ${a.permissionPromptCount},
      ${a.permissionDenyCount},
      ${a.interruptCount},
      ${a.userMessageCount},
      ${a.primaryModel}
    )`,
  );

  const affected = await db.$executeRaw(Prisma.sql`
    INSERT INTO sessions (
      session_id, user_id, agent_type,
      started_at, last_event_at, ended_at, status,
      is_resume, compaction_count, clear_count,
      host_hash, claude_code_version, os, cwd, repo_id,
      git_branch, git_commit, git_remote_url, git_is_dirty, pr_number,
      pr_ci_status, pr_review_decision,
      github_login, github_team, project_name,
      total_input_tokens, total_output_tokens, total_cache_read, total_cache_creation,
      total_cost_usd, tool_call_count, tool_error_count,
      permission_prompt_count, permission_deny_count, interrupt_count,
      user_message_count, primary_model
    ) VALUES ${Prisma.join(rows)}
    ON CONFLICT (session_id) DO UPDATE SET
      last_event_at        = GREATEST(sessions.last_event_at, EXCLUDED.last_event_at),
      ended_at             = COALESCE(sessions.ended_at, EXCLUDED.ended_at),
      status               = CASE
                               WHEN EXCLUDED.ended_at IS NOT NULL AND sessions.ended_at IS NULL THEN 'COMPLETED'::"SessionStatus"
                               ELSE sessions.status
                             END,
      total_input_tokens   = sessions.total_input_tokens + EXCLUDED.total_input_tokens,
      total_output_tokens  = sessions.total_output_tokens + EXCLUDED.total_output_tokens,
      total_cache_read     = sessions.total_cache_read + EXCLUDED.total_cache_read,
      total_cache_creation = sessions.total_cache_creation + EXCLUDED.total_cache_creation,
      total_cost_usd       = sessions.total_cost_usd + EXCLUDED.total_cost_usd,
      tool_call_count      = sessions.tool_call_count + EXCLUDED.tool_call_count,
      tool_error_count     = sessions.tool_error_count + EXCLUDED.tool_error_count,
      permission_deny_count = sessions.permission_deny_count + EXCLUDED.permission_deny_count,
      interrupt_count      = sessions.interrupt_count + EXCLUDED.interrupt_count,
      user_message_count   = sessions.user_message_count + EXCLUDED.user_message_count,
      compaction_count     = sessions.compaction_count + EXCLUDED.compaction_count,
      primary_model        = COALESCE(sessions.primary_model, EXCLUDED.primary_model),
      repo_id              = COALESCE(sessions.repo_id, EXCLUDED.repo_id),
      pr_ci_status         = COALESCE(sessions.pr_ci_status, EXCLUDED.pr_ci_status),
      pr_review_decision   = COALESCE(sessions.pr_review_decision, EXCLUDED.pr_review_decision),
      github_login         = COALESCE(sessions.github_login, EXCLUDED.github_login),
      github_team          = COALESCE(sessions.github_team, EXCLUDED.github_team),
      project_name         = COALESCE(sessions.project_name, EXCLUDED.project_name)
  `);

  return { sessionsTouched: affected };
}
