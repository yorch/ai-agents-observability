-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'CRASHED', 'TIMED_OUT', 'ABANDONED');

-- CreateEnum
CREATE TYPE "AgentType" AS ENUM ('CLAUDE_CODE', 'CURSOR', 'AIDER', 'COPILOT', 'CODEX', 'WINDSURF', 'OPENCODE');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('VIEW_SESSION', 'VIEW_TRANSCRIPT', 'EXPORT_TEAM', 'EXPORT_ORG', 'ADMIN_IMPERSONATE', 'DELETE_REQUEST', 'HOOK_TOKEN_ISSUED', 'ROLE_GRANT', 'RETENTION_OVERRIDE_CHANGED', 'GRANT_REQUESTED', 'GRANT_APPROVED', 'GRANT_REVOKED', 'ALERT_ACKNOWLEDGED', 'ALERT_SILENCED');

-- CreateEnum
CREATE TYPE "GrantScope" AS ENUM ('USER_SESSIONS', 'SINGLE_SESSION');

-- CreateEnum
CREATE TYPE "AuthTokenKind" AS ENUM ('ACCESS', 'REFRESH', 'HOOK');

-- CreateEnum
CREATE TYPE "TeamRole" AS ENUM ('MEMBER', 'LEAD', 'MAINTAINER');

-- CreateEnum
CREATE TYPE "OrgRole" AS ENUM ('MEMBER', 'ORG_ADMIN', 'VIEWER_AGGREGATE', 'INVESTIGATOR');

-- CreateEnum
CREATE TYPE "PRState" AS ENUM ('OPEN', 'CLOSED', 'MERGED');

-- CreateEnum
CREATE TYPE "LinkSource" AS ENUM ('SESSION_START', 'WEBHOOK_RECONCILE', 'MANUAL');

-- CreateTable
CREATE TABLE "teams" (
    "id" UUID NOT NULL,
    "github_slug" TEXT NOT NULL,
    "github_id" BIGINT NOT NULL,
    "name" TEXT NOT NULL,
    "parent_team_id" UUID,
    "synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retention_days" INTEGER,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "github_login" TEXT,
    "github_id" BIGINT,
    "email" TEXT,
    "password_hash" TEXT,
    "display_name" TEXT,
    "primary_team_id" UUID,
    "org_role" "OrgRole" NOT NULL DEFAULT 'MEMBER',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6),
    "deactivated_at" TIMESTAMPTZ(6),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_members" (
    "team_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role_in_team" "TeamRole" NOT NULL,
    "synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "left_at" TIMESTAMPTZ(6),

    CONSTRAINT "team_members_pkey" PRIMARY KEY ("team_id","user_id")
);

-- CreateTable
CREATE TABLE "repos" (
    "id" UUID NOT NULL,
    "github_owner" TEXT NOT NULL,
    "github_name" TEXT NOT NULL,
    "github_id" BIGINT,
    "default_branch" TEXT,
    "owning_team_id" UUID,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "repos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "kind" "AuthTokenKind" NOT NULL,
    "expires_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "visibility_policies" (
    "user_id" UUID NOT NULL,
    "share_metadata_with_team" BOOLEAN NOT NULL DEFAULT true,
    "share_metadata_with_org" BOOLEAN NOT NULL DEFAULT true,
    "share_transcripts_with_team" BOOLEAN NOT NULL DEFAULT false,
    "share_transcripts_with_org" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "visibility_policies_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" BIGSERIAL NOT NULL,
    "ts" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_user_id" UUID NOT NULL,
    "action" "AuditAction" NOT NULL,
    "target_user_id" UUID,
    "target_session_id" UUID,
    "target_team_id" UUID,
    "justification" TEXT,
    "ip" TEXT,
    "user_agent" TEXT,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "session_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "agent_type" "AgentType" NOT NULL DEFAULT 'CLAUDE_CODE',
    "agent_version" TEXT,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "ended_at" TIMESTAMPTZ(6),
    "last_event_at" TIMESTAMPTZ(6) NOT NULL,
    "status" "SessionStatus" NOT NULL,
    "end_reason" TEXT,
    "is_resume" BOOLEAN NOT NULL DEFAULT false,
    "resumed_from_session_id" UUID,
    "compaction_count" INTEGER NOT NULL DEFAULT 0,
    "clear_count" INTEGER NOT NULL DEFAULT 0,
    "host_hash" TEXT,
    "claude_code_version" TEXT,
    "os" TEXT,
    "cwd" TEXT,
    "repo_id" UUID,
    "git_branch" TEXT,
    "git_commit" TEXT,
    "git_remote_url" TEXT,
    "git_is_dirty" BOOLEAN,
    "pr_number" INTEGER,
    "pr_ci_status" TEXT,
    "pr_review_decision" TEXT,
    "github_login" TEXT,
    "github_team" TEXT,
    "team_id" UUID,
    "project_name" TEXT,
    "jira_key" TEXT,
    "mode" TEXT,
    "total_input_tokens" BIGINT NOT NULL DEFAULT 0,
    "total_output_tokens" BIGINT NOT NULL DEFAULT 0,
    "total_cache_read" BIGINT NOT NULL DEFAULT 0,
    "total_cache_creation" BIGINT NOT NULL DEFAULT 0,
    "total_cost_usd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "tool_call_count" INTEGER NOT NULL DEFAULT 0,
    "tool_error_count" INTEGER NOT NULL DEFAULT 0,
    "permission_prompt_count" INTEGER NOT NULL DEFAULT 0,
    "permission_deny_count" INTEGER NOT NULL DEFAULT 0,
    "interrupt_count" INTEGER NOT NULL DEFAULT 0,
    "user_message_count" INTEGER NOT NULL DEFAULT 0,
    "notification_count" INTEGER NOT NULL DEFAULT 0,
    "primary_model" TEXT,
    "transcript_s3_key" TEXT,
    "transcript_bytes" BIGINT,
    "transcript_uploaded_at" TIMESTAMPTZ(6),
    "transcript_redacted" BOOLEAN NOT NULL DEFAULT false,
    "shape_label" TEXT,
    "friction_score" DOUBLE PRECISION,
    "total_response_ms" BIGINT NOT NULL DEFAULT 0,
    "response_sample_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("session_id")
);

-- CreateTable
CREATE TABLE "pull_requests" (
    "repo_id" UUID NOT NULL,
    "pr_number" INTEGER NOT NULL,
    "github_id" BIGINT NOT NULL,
    "title" TEXT,
    "author_user_id" UUID,
    "author_github_login" TEXT NOT NULL,
    "state" "PRState" NOT NULL,
    "base_branch" TEXT,
    "head_branch" TEXT,
    "opened_at" TIMESTAMPTZ(6),
    "closed_at" TIMESTAMPTZ(6),
    "merged_at" TIMESTAMPTZ(6),
    "lines_added" INTEGER,
    "lines_removed" INTEGER,
    "files_changed" INTEGER,
    "review_count" INTEGER,
    "reviewer_logins" TEXT[],
    "labels" TEXT[],
    "enriched_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reverted_at" TIMESTAMPTZ(6),
    "revert_of_pr_number" INTEGER,
    "jira_key" TEXT,
    "is_draft" BOOLEAN,

    CONSTRAINT "pull_requests_pkey" PRIMARY KEY ("repo_id","pr_number")
);

-- CreateTable
CREATE TABLE "session_pr_links" (
    "session_id" UUID NOT NULL,
    "repo_id" UUID NOT NULL,
    "pr_number" INTEGER NOT NULL,
    "linked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "link_source" "LinkSource" NOT NULL,

    CONSTRAINT "session_pr_links_pkey" PRIMARY KEY ("session_id","repo_id","pr_number")
);

-- CreateTable
CREATE TABLE "pr_check_runs" (
    "id" BIGSERIAL NOT NULL,
    "repo_id" UUID NOT NULL,
    "pr_number" INTEGER NOT NULL,
    "github_id" BIGINT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "conclusion" TEXT,
    "head_sha" TEXT,
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "pr_check_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pr_reviews" (
    "id" BIGSERIAL NOT NULL,
    "repo_id" UUID NOT NULL,
    "pr_number" INTEGER NOT NULL,
    "github_id" BIGINT NOT NULL,
    "reviewer_login" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "submitted_at" TIMESTAMPTZ(6),

    CONSTRAINT "pr_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_commit_links" (
    "session_id" UUID NOT NULL,
    "repo_id" UUID NOT NULL,
    "commit_sha" TEXT NOT NULL,
    "author_login" TEXT,
    "committed_at" TIMESTAMPTZ(6),
    "linked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_commit_links_pkey" PRIMARY KEY ("session_id","repo_id","commit_sha")
);

-- CreateTable
CREATE TABLE "jira_issues" (
    "key" TEXT NOT NULL,
    "summary" TEXT,
    "issue_type" TEXT,
    "status" TEXT,
    "epic_key" TEXT,
    "project_key" TEXT,
    "project_name" TEXT,
    "story_points" DOUBLE PRECISION,
    "assignee" TEXT,
    "resolved_at" TIMESTAMPTZ(6),
    "synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "jira_issues_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "pr_rollups" (
    "repo_id" UUID NOT NULL,
    "pr_number" INTEGER NOT NULL,
    "contributing_user_ids" TEXT[],
    "contributing_session_ids" TEXT[],
    "first_session_at" TIMESTAMPTZ(6),
    "last_session_at" TIMESTAMPTZ(6),
    "total_active_seconds" INTEGER,
    "total_cost_usd" DECIMAL(12,6),
    "total_input_tokens" BIGINT,
    "total_output_tokens" BIGINT,
    "total_tool_calls" INTEGER,
    "total_tool_errors" INTEGER,
    "total_permission_denies" INTEGER,
    "cost_per_loc" DECIMAL(12,6),
    "check_failures_count" INTEGER NOT NULL DEFAULT 0,
    "computed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pr_rollups_pkey" PRIMARY KEY ("repo_id","pr_number")
);

-- CreateTable
CREATE TABLE "job_runs" (
    "id" BIGSERIAL NOT NULL,
    "job_name" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),
    "status" TEXT NOT NULL DEFAULT 'running',
    "error_text" TEXT,

    CONSTRAINT "job_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deletion_requests" (
    "id" BIGSERIAL NOT NULL,
    "user_id" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),
    "reason" TEXT,

    CONSTRAINT "deletion_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" BIGSERIAL NOT NULL,
    "delivery_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "action" TEXT,
    "repo" TEXT,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),
    "status" TEXT NOT NULL,
    "error_text" TEXT,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_config" (
    "job_name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "run_hour_utc" SMALLINT NOT NULL,
    "run_minute_utc" SMALLINT NOT NULL,
    "run_requested_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_config_pkey" PRIMARY KEY ("job_name")
);

-- CreateTable
CREATE TABLE "alert_rules" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "rule_type" TEXT NOT NULL,
    "params" JSONB NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "cadence_minutes" INTEGER NOT NULL DEFAULT 60,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "silenced_until" TIMESTAMPTZ(6),

    CONSTRAINT "alert_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_grants" (
    "id" UUID NOT NULL,
    "grantee_user_id" UUID NOT NULL,
    "target_user_id" UUID,
    "target_session_id" UUID,
    "scope" "GrantScope" NOT NULL,
    "justification" TEXT NOT NULL,
    "granted_by_user_id" UUID,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "granted_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "access_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_feedback" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "sentiment" TEXT NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "session_feedback_session_id_user_id_key" ON "session_feedback"("session_id", "user_id");

-- CreateIndex
CREATE INDEX "session_feedback_session_id_idx" ON "session_feedback"("session_id");

-- CreateTable
CREATE TABLE "alert_events" (
    "id" BIGSERIAL NOT NULL,
    "rule_id" UUID NOT NULL,
    "fired_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(6),
    "severity" TEXT NOT NULL,
    "details" JSONB NOT NULL DEFAULT '{}',
    "acknowledged_at" TIMESTAMPTZ(6),
    "acknowledged_by_user_id" UUID,

    CONSTRAINT "alert_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_channel_config" (
    "id" UUID NOT NULL,
    "channel_type" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alert_channel_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_delivery_log" (
    "id" BIGSERIAL NOT NULL,
    "channel_type" TEXT NOT NULL,
    "attempted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "success" BOOLEAN NOT NULL,
    "error" TEXT,

    CONSTRAINT "alert_delivery_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "teams_github_slug_key" ON "teams"("github_slug");

-- CreateIndex
CREATE UNIQUE INDEX "teams_github_id_key" ON "teams"("github_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_github_login_key" ON "users"("github_login");

-- CreateIndex
CREATE UNIQUE INDEX "users_github_id_key" ON "users"("github_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_last_seen_at_idx" ON "users"("last_seen_at");

-- CreateIndex
CREATE INDEX "team_members_user_id_idx" ON "team_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "repos_github_id_key" ON "repos"("github_id");

-- CreateIndex
CREATE UNIQUE INDEX "repos_github_owner_github_name_key" ON "repos"("github_owner", "github_name");

-- CreateIndex
CREATE INDEX "auth_tokens_user_id_idx" ON "auth_tokens"("user_id");

-- CreateIndex
CREATE INDEX "auth_tokens_token_hash_idx" ON "auth_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "audit_log_target_user_id_ts_idx" ON "audit_log"("target_user_id", "ts" DESC);

-- CreateIndex
CREATE INDEX "audit_log_actor_user_id_ts_idx" ON "audit_log"("actor_user_id", "ts" DESC);

-- CreateIndex
CREATE INDEX "sessions_user_id_started_at_idx" ON "sessions"("user_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "sessions_repo_id_started_at_idx" ON "sessions"("repo_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "sessions_status_last_event_at_idx" ON "sessions"("status", "last_event_at");

-- CreateIndex
CREATE INDEX "sessions_agent_type_started_at_idx" ON "sessions"("agent_type", "started_at" DESC);

-- CreateIndex
CREATE INDEX "sessions_jira_key_idx" ON "sessions"("jira_key");

-- CreateIndex
CREATE UNIQUE INDEX "pull_requests_github_id_key" ON "pull_requests"("github_id");

-- CreateIndex
CREATE INDEX "pull_requests_jira_key_idx" ON "pull_requests"("jira_key");

-- CreateIndex
CREATE UNIQUE INDEX "pr_check_runs_repo_id_pr_number_github_id_key" ON "pr_check_runs"("repo_id", "pr_number", "github_id");

-- CreateIndex
CREATE INDEX "pr_check_runs_repo_id_pr_number_completed_at_idx" ON "pr_check_runs"("repo_id", "pr_number", "completed_at");

-- CreateIndex
CREATE UNIQUE INDEX "pr_reviews_github_id_key" ON "pr_reviews"("github_id");

-- CreateIndex
CREATE INDEX "pr_reviews_repo_id_pr_number_idx" ON "pr_reviews"("repo_id", "pr_number");

-- CreateIndex
CREATE INDEX "session_commit_links_repo_id_commit_sha_idx" ON "session_commit_links"("repo_id", "commit_sha");

-- CreateIndex
CREATE INDEX "session_commit_links_committed_at_idx" ON "session_commit_links"("committed_at");

-- CreateIndex
CREATE INDEX "jira_issues_epic_key_idx" ON "jira_issues"("epic_key");

-- CreateIndex
CREATE INDEX "jira_issues_issue_type_idx" ON "jira_issues"("issue_type");

-- CreateIndex
CREATE INDEX "jira_issues_project_key_idx" ON "jira_issues"("project_key");

-- CreateIndex
CREATE INDEX "pull_requests_opened_at_idx" ON "pull_requests"("opened_at");

-- CreateIndex
CREATE INDEX "pull_requests_merged_at_idx" ON "pull_requests"("merged_at");

-- CreateIndex
CREATE INDEX "session_pr_links_repo_id_pr_number_idx" ON "session_pr_links"("repo_id", "pr_number");

-- CreateIndex
CREATE INDEX "job_runs_job_name_started_at_idx" ON "job_runs"("job_name", "started_at" DESC);

-- CreateIndex
CREATE INDEX "deletion_requests_user_id_idx" ON "deletion_requests"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_deliveries_delivery_id_key" ON "webhook_deliveries"("delivery_id");

-- CreateIndex
CREATE INDEX "webhook_deliveries_event_type_received_at_idx" ON "webhook_deliveries"("event_type", "received_at" DESC);

-- CreateIndex
CREATE INDEX "webhook_deliveries_received_at_idx" ON "webhook_deliveries"("received_at" DESC);

-- CreateIndex
CREATE INDEX "alert_rules_enabled_idx" ON "alert_rules"("enabled");

-- CreateIndex
CREATE INDEX "access_grants_grantee_user_id_expires_at_idx" ON "access_grants"("grantee_user_id", "expires_at");

-- CreateIndex
CREATE INDEX "access_grants_granted_at_revoked_at_idx" ON "access_grants"("granted_at", "revoked_at");

-- CreateIndex
CREATE INDEX "alert_events_rule_id_resolved_at_idx" ON "alert_events"("rule_id", "resolved_at");

-- CreateIndex
CREATE INDEX "alert_delivery_log_attempted_at_idx" ON "alert_delivery_log"("attempted_at" DESC);

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_parent_team_id_fkey" FOREIGN KEY ("parent_team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_primary_team_id_fkey" FOREIGN KEY ("primary_team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repos" ADD CONSTRAINT "repos_owning_team_id_fkey" FOREIGN KEY ("owning_team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visibility_policies" ADD CONSTRAINT "visibility_policies_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_target_user_id_fkey" FOREIGN KEY ("target_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_target_team_id_fkey" FOREIGN KEY ("target_team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_repo_id_fkey" FOREIGN KEY ("repo_id") REFERENCES "repos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pr_check_runs" ADD CONSTRAINT "pr_check_runs_repo_id_pr_number_fkey" FOREIGN KEY ("repo_id", "pr_number") REFERENCES "pull_requests"("repo_id", "pr_number") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pr_reviews" ADD CONSTRAINT "pr_reviews_repo_id_pr_number_fkey" FOREIGN KEY ("repo_id", "pr_number") REFERENCES "pull_requests"("repo_id", "pr_number") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_commit_links" ADD CONSTRAINT "session_commit_links_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("session_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_commit_links" ADD CONSTRAINT "session_commit_links_repo_id_fkey" FOREIGN KEY ("repo_id") REFERENCES "repos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_repo_id_fkey" FOREIGN KEY ("repo_id") REFERENCES "repos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_author_user_id_fkey" FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_pr_links" ADD CONSTRAINT "session_pr_links_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("session_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_pr_links" ADD CONSTRAINT "session_pr_links_repo_id_pr_number_fkey" FOREIGN KEY ("repo_id", "pr_number") REFERENCES "pull_requests"("repo_id", "pr_number") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pr_rollups" ADD CONSTRAINT "pr_rollups_repo_id_pr_number_fkey" FOREIGN KEY ("repo_id", "pr_number") REFERENCES "pull_requests"("repo_id", "pr_number") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deletion_requests" ADD CONSTRAINT "deletion_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_grantee_user_id_fkey" FOREIGN KEY ("grantee_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_events" ADD CONSTRAINT "alert_events_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "alert_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;
