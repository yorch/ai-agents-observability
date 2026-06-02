-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('active', 'completed', 'crashed', 'timed_out', 'abandoned');

-- CreateEnum
CREATE TYPE "AgentType" AS ENUM ('claude_code');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('view_session', 'view_transcript', 'export_team', 'export_org', 'admin_impersonate', 'delete_request', 'hook_token_issued');

-- CreateEnum
CREATE TYPE "AuthTokenKind" AS ENUM ('access', 'refresh', 'hook');

-- CreateEnum
CREATE TYPE "TeamRole" AS ENUM ('member', 'lead', 'maintainer');

-- CreateEnum
CREATE TYPE "PRState" AS ENUM ('open', 'closed', 'merged');

-- CreateEnum
CREATE TYPE "LinkSource" AS ENUM ('session_start', 'webhook_reconcile', 'manual');

-- CreateTable
CREATE TABLE "teams" (
    "id" UUID NOT NULL,
    "github_slug" TEXT NOT NULL,
    "github_id" BIGINT NOT NULL,
    "name" TEXT NOT NULL,
    "parent_team_id" UUID,
    "synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "github_login" TEXT NOT NULL,
    "github_id" BIGINT NOT NULL,
    "email" TEXT,
    "display_name" TEXT,
    "primary_team_id" UUID,
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
    "agent_type" "AgentType" NOT NULL DEFAULT 'claude_code',
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
    "opus_turns" INTEGER NOT NULL DEFAULT 0,
    "sonnet_turns" INTEGER NOT NULL DEFAULT 0,
    "haiku_turns" INTEGER NOT NULL DEFAULT 0,
    "primary_model" TEXT,
    "transcript_s3_key" TEXT,
    "transcript_bytes" BIGINT,
    "transcript_uploaded_at" TIMESTAMPTZ(6),
    "transcript_redacted" BOOLEAN NOT NULL DEFAULT false,

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
    "computed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pr_rollups_pkey" PRIMARY KEY ("repo_id","pr_number")
);

-- CreateTable
CREATE TABLE "job_runs" (
    "id" BIGSERIAL NOT NULL,
    "job_name" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),
    "status" TEXT NOT NULL,
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

-- CreateIndex
CREATE UNIQUE INDEX "teams_github_slug_key" ON "teams"("github_slug");

-- CreateIndex
CREATE UNIQUE INDEX "teams_github_id_key" ON "teams"("github_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_github_login_key" ON "users"("github_login");

-- CreateIndex
CREATE UNIQUE INDEX "users_github_id_key" ON "users"("github_id");

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
CREATE UNIQUE INDEX "pull_requests_github_id_key" ON "pull_requests"("github_id");

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
