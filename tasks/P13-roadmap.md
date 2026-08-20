# Phase 13 — Scoring & Evaluation (roadmap)

**Trigger to decompose**: [`docs/research/2026-08-12-llm-evals-assessment.md`](../docs/research/2026-08-12-llm-evals-assessment.md).
The owner resolved that document's first open question: **evaluating real sessions
against real outcomes ("scope B") is a goal.** `DESIGN_DOC.md` §2.2's
"prompt evaluation" non-goal is scoped to *model-level* evaluation (benchmarking,
drift, RAG quality) and is annotated accordingly.

## Deployment context — read this before picking a task

This phase is planned against an honest statement of where the project actually is
(2026-08-12):

- **The corpus is seed and dev data only.** No production rollout has happened. The
  seed script (`packages/db/src/seed.ts`) produces a rich synthetic dataset —
  sessions, events, PRs, transcripts, 24 `SessionFeedback` rows — which is enough to
  *develop and exercise* a surface, and nowhere near enough to *validate* a scorer.
- **A real rollout is intended but unscheduled**, and the blocker is bandwidth and
  priority rather than anything technical, political, or operational.

Two sequencing rules follow, and every task below is placed by them:

1. **Build only what pays off regardless of whether rollout happens.** A task whose
   entire value is contingent on a corpus that may not arrive is not `ready`; it is
   waiting.
2. **Prefer what gets more expensive with time.** The substrate (P13-001) is cheapest
   before there is scored history to migrate; the hook contract (P13-002) is cheapest
   before real clients ship a version that would need bumping.

### The data precondition

Tasks below marked *blocked (data)* are blocked on this, stated once here so each task
can reference it rather than re-litigate it:

> **DP-1** — telemetry from **≥10 real users** over **≥60 days**, yielding **≥200
> sessions with human labels** stratified across shape and friction bands, and **≥100
> outcome-linked PRs** (merged, with revert and CI status resolved).

Below DP-1, a calibration or correlation result is not merely weak — it is an
underpowered number that reads as a verdict, which is the exact failure mode
`DESIGN_DOC.md` §10.6 and this phase exist to prevent. These tasks unblock themselves
when the corpus arrives; nobody needs to make a decision to unblock them.

## Current state (what exists)

The platform already ships evals — it just does not call them that, version them, or
check them.

- `friction_score` is a **heuristic composite scorer** over a session trajectory
  (`packages/schemas/src/effectiveness.ts` — `FRICTION_WEIGHTS`, denial/error/
  interrupt/abandonment), computed nightly by
  `apps/ingest/src/jobs/compute-effectiveness.ts`, and rendered on `/me/insights`,
  `/team/[slug]`, `/org/dashboard`, as a search facet, and as the driver of the
  coaching recommendations in `apps/web/src/lib/recommendations.ts`.
- `shape_label` is a **classifier** (exploratory / implementation / debugging /
  planning) over a tool histogram.
- `SessionFeedback` collects a **human label** from the one person who knows the
  ground truth — currently a bare sentiment, used to validate nothing.
- Neither scorer has a gold set, a confusion matrix, an accuracy claim, or a measured
  relationship to any outcome. Their weights are asserted.
- `FRICTION_VERSION = 1` exists as a constant with **nowhere to be recorded per
  score** — a version pin maintained by convention, which is why `DESIGN_DOC.md`
  §12.7 had to describe the effectiveness widgets as "version-pinned."
- Scores live as columns on `sessions`, so there is no scorer identity, no provenance,
  no rationale, and no room for a second scorer to disagree.
- `compute-effectiveness` uses `shape_label IS NULL` as its idempotency marker, so a
  scored session **never re-enters the candidate set** — improving a scorer cannot
  re-score history without another bespoke backfill job (the pattern already spent on
  `backfill-redaction` and `compute-effectiveness-backfill`).
- `/org/quality` + P11-004 (Fisher's exact on friction-band deltas) is the one place
  the product validates a claim statistically. It is the seed for this phase.

**Note on urgency.** Because no real user reads these dashboards yet, the unvalidated
scores are not currently misleading anyone. The debt is real and worth paying — and it
is *cheaper to pay now than after rollout*, which is the argument for this phase, not
"we are actively shipping a wrong number."

## The asset this phase exploits

Eval platforms score traces that have *no ground truth*, which is why they lean on
LLM-as-judge and then spend heavily calibrating it. This platform's traces terminate in
`pull_requests.merged_at` / `reverted_at`, `pr_ci_status`, `pr_review_decision`,
`pr_check_runs`, and `jira_issues` defect tickets — hard labels arriving automatically,
weeks later, on real work, already correlated by `session_pr_links` and
`session_commit_links`. That inverts the usual eval problem: **outcomes can validate
scorers**, rather than a judge having to guess quality. It also means the gold set
partly builds itself — reverted PRs, CI-failed merges, and thumbs-down
`SessionFeedback` are a naturally-curated hard-example set.

That asset is why P13-005 (label capture) is `ready` despite the validation work being
blocked: labels and outcomes accrue *during* rollout only if the capture path exists
*before* it.

## Workstreams

| | Workstream | Tasks | Posture |
|---|---|---|---|
| **A** | **Substrate** — the scoring primitive everything else writes into | P13-001, P13-002 | ready; cheapest now |
| **B** | **Deterministic scorers** — trajectory metrics from data already stored | P13-003, P13-004 | ready; no new data source needed |
| **C** | **Capture & validation** | P13-005, P13-006 ready · P13-007, P13-008 blocked (data) | capture now, analysis on DP-1 |
| **D** | **Judge** — LLM-as-judge over transcripts | P13-009 ready · P13-010, P13-011 blocked | build it, don't arm it |

**Workstream D's posture, explicitly.** An earlier draft of this roadmap hard-blocked
the entire judge workstream on calibration plus a developer consultation. With
seed-only data and no rollout, both conditions are unreachable, which would have been
a cancellation wearing a blocker's clothing. The split instead is: **build the runner
and its guardrails now, exercised against the owner's own transcripts; gate the
irreversible act — pointing it at another person's transcript — behind DP-1 and the
consultation.** The guardrails (consent gating, audit writes, owner-only display,
versioned prompt registry, cost recording) are acceptance criteria of the buildable
task, not follow-ups, because they are exactly the things that never get retrofitted.

## Sketched tasks

### A — Substrate

- **P13-001 Generic versioned scores table** *(ready)*
  One `scores` table — `(subject_type, subject_id, scorer_name, scorer_version,
  source, value, label, rationale_ref, cost_usd, created_at)` — with
  `friction_score`/`shape_label` migrated to write rows. Existing columns stay as a
  denormalized "current" cache so no dashboard breaks. Makes re-scoring, scorer
  comparison, and calibration possible at all. Field names designed *toward* the
  emerging OTel GenAI evaluation event without pinning to a Development-status spec.

- **P13-002 `run_kind` dimension** *(ready)*
  `interactive` | `ci` | `eval` on sessions and events, defaulting to `interactive`,
  excluded from human aggregates. Resolves `DESIGN_DOC.md` §13 Q8 and makes the
  ingest contract hospitable to a future external eval harness without building one.
  Cheapest before real clients ship.

### B — Deterministic scorers

- **P13-003 Deterministic trajectory scorers** *(ready)*
  Retry loops (repeated `tool_input_hash`), edit-thrash, redundant re-reads,
  denial→retry→success chains, tests-run-before-merge, step efficiency against a
  per-shape baseline. All inputs are in the events hypertable. No judge, no token
  cost, no content access.

- **P13-004 Skill & MCP effectiveness scoring** *(ready)*
  Per `skill_name` and `mcp_server`: invocation volume against downstream friction,
  tool-error rate, and PR outcome. The feedback loop `DESIGN_DOC.md` §15 asks for.
  Renders against seed data; its *comparisons* stay volume-gated, so it degrades
  honestly to "not yet measurable" rather than producing noise.

### C — Capture & validation

- **P13-005 Session label capture** *(ready)*
  Extend `SessionFeedback` from a bare sentiment into a small versioned rubric — which
  shape best describes this session, and did it accomplish what you wanted
  (yes / partly / no). **This is product, not instrumentation**: a developer rating
  their own session is a feature, and it is the only label source that is both cheap
  and trust-preserving. Ships now so labels accrue from day one of rollout instead of
  starting at zero whenever someone finally wants to calibrate.

- **P13-006 Projection registry + realization** *(ready)*
  Any surface that makes a predictive claim registers it — claim type, segment,
  projected **range**, baseline, active price-table/scorer version, timestamp — and a
  shared function later reports realized-vs-projected with an outcome guard.
  The *registry* pays off immediately (claims made before it exists can never be
  checked); the realization panel renders "not yet measurable" until data arrives.
  Supersedes [`P10-006`](./P10-006-recommendation-validation-loop.md).

- **P13-007 Scorer calibration analysis** *(blocked — DP-1)*
  The measured answer: `shape_label` accuracy and confusion matrix against human
  labels; `friction_score` correlation with revert / CI failure / review churn / owner
  sentiment, each significance-tested with an effect size; inter-rater agreement where
  two humans labelled the same session. Publishes the figure *next to the score*.
  A negative result is a deliverable, not a failure.

- **P13-008 Scorer validation surface** *(blocked — DP-1)*
  Generalizes P11-004 from one metric to a framework: per scorer, its relationship to
  outcomes over time with significance testing, so a scorer that stops predicting
  becomes visibly one to retire.

### D — Judge

- **P13-009 Judge runner + guardrails** *(ready — own transcripts only)*
  The sampled, batched, scheduler-run LLM-as-judge, built with consent gating, audit
  writes, owner-only display, a versioned prompt registry, and `cost_usd` recording as
  acceptance criteria. Exercised only against the owner's own sessions and seed data.

- **P13-010 Judge calibration + drift alerting** *(blocked — DP-1)*
  Compares judge output against the P13-007 gold set and against outcomes, with drift
  alerting through the Phase 9 engine. A judge without this is theatre.

- **P13-011 Arm the judge for other users' transcripts** *(blocked — DP-1 + consultation)*
  The irreversible step, deliberately its own task with its own decision: flipping the
  judge from "my own sessions" to "consented sessions belonging to other people."
  Requires P13-010 reporting agreement above a stated threshold **and** an explicit
  owner decision taken with developers consulted, not after the fact.

## Exit criteria

Scoped to what is achievable without a rollout; the DP-1 criteria are stated
separately so the phase can be honestly "done except for what needs data."

**Achievable now:**

- Every computed signal in the product is a row in `scores` with a scorer name, a
  version, and a source, and can be re-computed without a bespoke backfill job.
- Trajectory scorers are computed from the events hypertable with no transcript
  access and no per-token cost, and return null rather than a number below a
  minimum-volume threshold.
- A developer can record a structured, versioned judgement of their own session, and
  the rubric version is stored with it.
- Every predictive claim the product makes is registered as a projection at the moment
  it is made.
- Eval / CI runs, if any arrive, are stored and trendable but excluded from every
  human aggregate by default.
- The judge runner exists, is off by default, has never been pointed at a transcript
  belonging to anyone but its operator, and cannot be — consent gating and audit
  writes are enforced in code, verified by test.
- **No individual's score is visible to anyone but them.** No surface ranks
  developers by any score.

**On DP-1:**

- `shape_label` has a published accuracy figure against human labels, and
  `friction_score` has a published, significance-tested relationship to at least one
  outcome — or one of them has been retired on the evidence.
- A developer sees not just their friction score but how accurate that score has been,
  and the same figure follows the score to every team and org surface.
- An org admin can see which computed signals still predict real outcomes and which
  have gone stale.
- If the judge is armed: every read is consent-gated and audit-logged, judge spend
  appears in the platform's own cost dashboards, and no judge output about an
  individual reaches a team or org surface except as a small-n-suppressed aggregate.

## Out of scope

- **Model / agent benchmarking, and any leaderboard framing.** Ranking models,
  agents, or developers is not this phase and not this product (`DESIGN_DOC.md` §2.2,
  §10.5). The legitimate version of the agent-comparison question is the
  *observational* one already at `/org/agents`.
- **Real-time or in-hook evaluation.** The hook's <10ms budget (`DESIGN_DOC.md` §6.2)
  forbids it. All scoring is post-hoc, batch, server-side.
- **An agent execution runner inside this repo.** The agent-config eval harness
  (skills / `CLAUDE.md` / MCP regression testing) needs to *execute* the agent against
  fixtures — a CI-side concern. P13-002 makes the ingest contract hospitable to one;
  building it here would break the observe-only invariant.
- **Per-developer quality scores exposed to managers.** Structurally excluded via the
  exit criteria, not merely discouraged.
- **Any judge over a non-consented transcript**, and any judge over another person's
  transcript at all before P13-011.
- **Synthesising a gold set from seed data.** Calibrating a scorer against fixtures
  measures the fixture generator, not the scorer. This is why P13-007 is blocked
  rather than approximated.
- **Adopting the OTel GenAI wire format.** Design toward it; it is Development-status
  with no stabilization timeline.

## Relationship to Phase 10

Both phases are proposed and unstarted, and no order is implied between them. The one
real coupling: **P13-006 supersedes P10-006** (recommendation validation loop) by
implementing the same projected-vs-realized check as a general mechanism. Whichever
phase lands second absorbs the other's task — if P10 runs first, P10-006 should be
left unbuilt and marked superseded; if P12 runs first, P13-006 satisfies it outright.
