# Phase 4 — Org views, search, ops handoff (roadmap)

**Status**: Fully decomposed into P4-001 … P4-011; all Phase 4 tasks are `done`. See [`INDEX.md`](./INDEX.md) for task-level status.

**Trigger to decompose**: Phase 3 exit criteria met.

## Goal recap

Org-level aggregates for leadership. Faceted search across sessions (visibility-aware at query time). Transcript full-text search. Anomaly surfaces. **Platform/SRE handoff deliverables** — this phase ends with the system out of dev-tools hands.

See `DESIGN_DOC.md` §12.4 and §15.

## Sketched tasks

- **P4-001 `viewer_aggregate` role + org dashboard**
  Sees rollups (team-level, repo-level, model-level), never raw rows. Cost by team / repo / model. Time-series of weekly spend.
- **P4-002 Faceted search**
  Filter sessions by user, team, repo, model, tool, date. Filters compose. Scoped at query layer, never at result layer.
- **P4-003 Transcript FTS index**
  `transcript_index` Postgres FTS table populated by ingest. Search UI in web. Visibility-scoped.
- **P4-004 Continuous aggregates**
  Daily/weekly rollups via Timescale continuous aggregates. Powers org dashboards without hitting raw `events`.
- **P4-005 Anomaly surfaces**
  Spend spikes (>2σ over 14d baseline), error-rate jumps, suspicious_identity_claim count. Cards on org dashboard.
- **P4-006 Deletion job runner**
  Process the `DeletionRequest` queue from P1-027. Cascades to events, sessions, transcripts (object delete), PR links.
- **P4-007 Retention enforcement**
  Verify MinIO lifecycle policy is deleting transcripts > 1y. Sweep job for orphan object keys.
- **P4-008 Runbooks**
  `docs/runbooks/{ingest-down,minio-full,timescale-slow,oauth-broken,webhook-failing}.md`. Each: symptoms, diagnosis, mitigation, escalation.
- **P4-009 SLOs**
  Defined for ingest (99.5% / p99 < 200ms), web (99% / p95 < 1s), webhook delivery. Error budgets documented.
- **P4-010 Dashboards (Grafana or similar)**
  Per-service: QPS, error rate, latency percentiles, queue depths, DB conn pool, MinIO usage. Linked from runbooks.
- **P4-011 On-call doc + escalation path**
  Who's paged for what, response-time expectations, rotation cadence, training plan for the receiving team.

## Exit criteria

- [ ] Quarterly leadership readout runs entirely off the org dashboard.
- [ ] Platform/SRE on-call has handled at least one incident end-to-end without dev-tools help.
- [ ] SLOs measured for 30 consecutive days within budget.
- [ ] All runbooks dry-run-tested.
