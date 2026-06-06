-- Phase 4 + 5 schema additions

-- OrgRole enum for org-level access control
CREATE TYPE "OrgRole" AS ENUM ('member', 'org_admin', 'viewer_aggregate');

-- Add org_role to users (default: member)
ALTER TABLE "users" ADD COLUMN "org_role" "OrgRole" NOT NULL DEFAULT 'member';

-- Add session effectiveness fields (Phase 5)
ALTER TABLE "sessions" ADD COLUMN "shape_label" TEXT;
ALTER TABLE "sessions" ADD COLUMN "friction_score" DOUBLE PRECISION;
