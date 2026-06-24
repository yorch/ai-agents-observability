-- Add the `role_grant` audit action (org-admin assigning a team-lead role).
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'role_grant';
