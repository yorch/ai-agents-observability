-- AlterTable: add draft status to pull_requests (nullable; populated from GitHub webhook)
ALTER TABLE "pull_requests" ADD COLUMN "is_draft" BOOLEAN;
