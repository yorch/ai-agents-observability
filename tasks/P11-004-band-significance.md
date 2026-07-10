# P11-004 — Significance testing on friction-band deltas

**Status**: done
**Phase**: 11 — Correlation & Jira integration
**Estimate**: S
**Depends on**: P11-003

## Goal

Close the "formal significance testing" deferral from P11-003: the
`/org/quality` friction-band table shows rate differences, but gave the reader
no way to tell a real delta from noise beyond the small-sample muting.

## Scope

- **Fisher's exact test** (two-tailed) per band × outcome, comparing the
  medium and high bands against the low-friction baseline for revert rate,
  CI-failure rate, and bug-linked rate. Fisher (not z/chi-squared) because it
  is exact at any sample size — with today's volumes the tests simply won't
  reach significance, which is the honest answer rather than a reason to keep
  deferring. Implemented dependency-free in `apps/web/src/lib/stats.ts`
  (log-factorial hypergeometric enumeration, matching R's `fisher.test` /
  scipy's `fisher_exact`).
- **Surfacing**: every medium/high rate cell carries the p-value vs the low
  band as a hover tooltip; rates significant at p < 0.05 get an amber `*`.
  No baseline band → no tests, page renders as before.
- **Not tested**: avg cost per PR — it is a mean without variance data, so no
  honest test exists at the query's current shape. Called out in the footnote.
- The MIN_SAMPLE muting stays: significance and sample-size smallness are
  independent signals (a tiny band can't be significant, but a 12-PR band can
  be both un-muted and not significant).

## Acceptance criteria

- [x] `fisherExactTwoTailed` matches R/scipy reference values
      ([[1,9],[11,3]] → 0.0027594; [[3,1],[1,3]] → 0.4857143) and returns 1
      on degenerate margins.
- [x] Medium/high rate cells show a p-value tooltip; `*` appears only below
      p < 0.05; nothing renders when the low band is absent or empty.
- [x] All four gates pass.

## Still deferred

- Post-merge defect *windows* (bug created within N days of a merge, no
  explicit link) — carried over from P11-003; heuristic, stays out until
  someone asks.
- Multiple-comparison correction (6 tests per render). At two bands × three
  outcomes the Bonferroni factor is small and the page frames everything as
  association anyway; revisit if the band/outcome grid grows.
