-- Phase 5 features: multi-agent enum widening, revert detection,
-- GitHub Checks correlation, Jira key extraction

-- P5-006: widen AgentType to accept non-Claude agents
ALTER TYPE "AgentType" ADD VALUE IF NOT EXISTS 'cursor';
ALTER TYPE "AgentType" ADD VALUE IF NOT EXISTS 'aider';
ALTER TYPE "AgentType" ADD VALUE IF NOT EXISTS 'copilot';

-- P5-003: revert detection columns on pull_requests
ALTER TABLE pull_requests
  ADD COLUMN IF NOT EXISTS reverted_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revert_of_pr_number INT;

-- P5-005: check-run failure counter on pr_rollups
ALTER TABLE pr_rollups
  ADD COLUMN IF NOT EXISTS check_failures_count INT NOT NULL DEFAULT 0;

-- P5-004: Jira issue key extracted from branch name
ALTER TABLE pull_requests
  ADD COLUMN IF NOT EXISTS jira_key TEXT;

-- Index for Jira lookups (sparse — most rows will be NULL)
CREATE INDEX IF NOT EXISTS idx_pull_requests_jira_key
  ON pull_requests (jira_key)
  WHERE jira_key IS NOT NULL;
