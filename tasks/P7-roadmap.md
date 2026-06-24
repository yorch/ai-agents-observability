# Phase 7 — Insight surfaces & search (roadmap)

**Trigger to decompose**: post-P6 gap assessment. Effectiveness signals (`friction_score`,
`shape_label`) are computed by the nightly job and stored in the DB but are rendered in
zero UI widgets. Transcript full-text search is org-admin-only — individual developers
cannot search their own sessions. Faceted session search has no effectiveness-aware
filters. The platform captures the data; Phase 7 makes users see it.

## Goal recap

Move from "we capture it" to "the user sees it":

- Surface friction score and session shape across /me, team, and org dashboards.
- Give every developer full-text search over their own session transcripts (not just org admins).
- Enrich the existing faceted search with effectiveness-derived filters (shape, friction band, agent type).
- Spike semantic transcript search to answer whether keyword FTS is sufficient long-term.

See `DESIGN_DOC.md` §10.3 (Captured Now, Surfaced Later), §10.6 (Effectiveness Caveat),
and §12.5 for the scope and known limitations this phase closes.

## Sketched tasks

- **P7-001 Effectiveness backfill**
  Widen `compute-effectiveness` to cover all historical sessions that lack
  `friction_score`/`shape_label`, not just the rolling 48h window. One-shot
  admin job, idempotent, batched. Required before any UI can trust the coverage.

- **P7-002 Effectiveness query layer**
  Query helpers (`getUserEffectiveness`, aggregate percentiles, shape histogram)
  with on-the-fly fallback for null DB values. Unit tested. Consumed by all three
  effectiveness UI tasks.

- **P7-003 /me effectiveness widgets**
  Friction-over-time widget + shape-distribution widget on /me. Friction badge on
  session detail page. Version-cited (`FRICTION_VERSION`); suppressed for low-data
  sessions per §10.6.

- **P7-004 Team + org effectiveness**
  Friction distribution + shape mix on `/team/[slug]` and `/org/dashboard`.
  Visibility-policy-aware — no individual scores leak to aggregate viewers.

- **P7-005 /me transcript search**
  Per-user FTS at `/me/search` scoped strictly to the requesting user's own
  sessions. Reuses the `transcript_index` GIN index and `plainto_tsquery` approach
  from org search; adds a `user_id` scope predicate.

- **P7-006 Search facet enrichment**
  Add `shape_label`, friction band, and `agent_type` filters to the existing
  faceted search on `/org/search` and `/me` session list.

- **P7-007 Semantic transcript search (gated spike)**
  pgvector-based semantic search spike — evaluate embedding model, storage, and
  query cost; deliver a decision doc + thin prototype behind a flag. Not a
  production rollout; go/no-go recommendation only.

## Exit criteria

- A developer can see their friction trend and shape distribution on /me without
  navigating to an org-admin view.
- A team lead sees team friction distribution on the team dashboard, honoring
  `share_metadata_with_team` visibility policies; no individual scores are exposed
  to viewers without the `lead` role.
- A developer can full-text search their own session transcripts from /me/search;
  results are scoped to their sessions and cannot leak cross-user.
- Every effectiveness widget cites `FRICTION_VERSION` and suppresses numeric scores
  for sessions the formula marks null (insufficient data), per `DESIGN_DOC.md` §10.6.
