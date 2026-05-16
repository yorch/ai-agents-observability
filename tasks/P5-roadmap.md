# Phase 5 — Effectiveness signals (roadmap)

**Trigger to decompose**: Phase 4 exit criteria met, or earlier if a specific signal becomes strategically urgent.

## Goal recap

Move from "what happened" to "did it work". Friction score, session-shape clusters, revert detection, optional Jira/Checks correlation. Cited in real decision-making (promo, planning), not just dashboards.

See `DESIGN_DOC.md` §12.5.

## Sketched tasks

- **P5-001 Friction score**
  Composite metric per session: weighted sum of retries, denials, interrupts, abandonment. Surfaced on `/me/sessions` and team views. Tunable weights, version-pinned.
- **P5-002 Session-shape clustering**
  Per-session tool histogram vector → k-means → label (exploratory / focused-edit / debugging / multi-tool / …). Materialized into `Session.shape_label`. Cluster definitions documented + reproducible.
- **P5-003 Revert detection**
  Use `git log --follow` over PR commits in `pull_requests`. Flag if commit reverted within N days. Surface on `/me/prs`.
- **P5-004 Jira integration (gated on §13 Q6)**
  If S1 has a branch→Jira convention, ladder `PRRollup` to feature-level. Read-only Jira API; cache aggressively.
- **P5-005 GitHub Checks correlation**
  Correlate session activity with check failures on the related PR. "Sessions that produced check-failing code" surface.
- **P5-006 Multi-agent (`agent_type=cursor`) adapter**
  If demand: a Cursor adapter that emits compatible events. Spike first; full integration only if dogfooded.

## Exit criteria

- [ ] At least one effectiveness signal cited in a real promo packet or planning doc.
- [ ] Friction score correlates with self-reported "bad sessions" in a small survey (n ≥ 20).
- [ ] Clusters stable across retraining runs (label assignments don't churn week-to-week).
