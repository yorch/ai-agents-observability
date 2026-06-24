-- Phase 9 (P9-005): investigator org role — aggregate access + can request
-- time-boxed grants, never standing individual access.
ALTER TYPE "OrgRole" ADD VALUE IF NOT EXISTS 'investigator';
