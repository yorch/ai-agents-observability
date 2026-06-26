# Phase 3 — Team views (roadmap)

**Status**: Fully decomposed into P3-001 … P3-007; all Phase 3 tasks are `done`. See [`INDEX.md`](./INDEX.md) for task-level status.

**Trigger to decompose**: Phase 2 exit criteria met.

## Goal recap

Team leads see their team's aggregated usage and (with permission) individual sessions. Cross-user reads are gated by `VisibilityPolicy` and recorded in `AuditLog`. No org views yet.

See `DESIGN_DOC.md` §8 (Access Control & Privacy) and §12.3.

## Sketched tasks

- **P3-001 Role middleware (team_lead)**
  Resolve roles via `TeamMember.role_in_team`. Server helper `requireRole('team_lead', team_id)`.
- **P3-002 `/team/[slug]` overview**
  Team-scoped equivalents of the `/me` cards: cost, session count, top tools, model mix. Aggregates only — no individual-attributable data unless drilled in.
- **P3-003 Roster page**
  Team members with their high-level activity (count, cost) — gated by `share_costs_with_team`.
- **P3-004 Drill-in to user sessions**
  Team lead can view a member's sessions if `share_transcripts_with_team` is true; transcript viewer respects per-session policy.
- **P3-005 Audit log writes on every cross-user view**
  Every team-scoped read of another user's data writes an `AuditLog` row. Verified by negative test: a request that doesn't audit fails CI.
- **P3-006 Privacy enforcement test suite**
  Property tests: random user/role combinations + visibility policies; assert exposure matches policy. This is the safety net.
- **P3-007 `/me/audit` populated**
  With Phase 3 generating real audit rows, the page becomes meaningful. Add filters (actor, date, action).

## Exit criteria

- [ ] Team leads use the dashboard at least weekly (measured by access logs).
- [ ] Zero privacy incidents (no audit-log gap).
- [ ] Privacy enforcement test suite passes with 100% of generated cases.
