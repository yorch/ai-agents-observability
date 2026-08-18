# LLM Evals: Research & Capability Assessment

**Date:** 2026-08-12
**Scope:** What "LLM evals" means in 2026, what `ai-agents-observability` does today, and where — if anywhere — evals fit this product.
**Status:** Research / assessment. This is an input for a build/don't-build discussion, in the same spirit as [`2026-06-30-human-in-the-loop-assessment.md`](./2026-06-30-human-in-the-loop-assessment.md).

> **Resolved after writing (2026-08-12).** The owner answered §6 Q1: **scope B is a goal.** `DESIGN_DOC.md` §2.2's "prompt evaluation" non-goal is now scoped to model-level evaluation, and the recommendations below are decomposed as Phase 13 ([`tasks/P13-roadmap.md`](../../tasks/P13-roadmap.md)). Nothing here is implemented yet.
>
> **Deployment context (established after writing, and it changes the urgency).** The platform has **not been rolled out** — the corpus is seed and dev data, and a real rollout is intended but unscheduled, blocked on bandwidth rather than anything technical or political. Two corrections follow, applied inline below:
>
> 1. **The unvalidated scores are not currently misleading anyone**, because no real user reads those dashboards yet. Where this document says a scorer is "shipped to three audiences," read *the surfaces exist and would mislead once real users arrive*. The debt is real; the harm is prospective.
> 2. **That strengthens the substrate argument and weakens the calibration one.** P13-001 and P13-002 get more expensive with every session and every shipped hook version, so they are cheapest now. The calibration work (§3.4 R2) cannot run at all against generated fixtures — calibrating against seed data measures the fixture generator — so it is gated on a stated data precondition rather than scheduled.
>
> The judge gating in §3.4 R7 was also revised. This document argued for blocking the judge behind calibration; with no third-party transcripts in existence, that would have been a cancellation wearing a blocker's clothing. The phase instead splits it: build the runner **with** its guardrails as acceptance criteria (P13-009), and gate the irreversible act — pointing it at another person's transcript — separately (P13-011). The reasoning in §4 is unchanged and is why the guardrails are not follow-ups.

---

## 0. TL;DR

**What evals are.** An *eval* is a repeatable measurement of an AI system's behaviour against a definition of "good." The field splits along three axes: **when** (offline, on a fixed dataset, before you ship — vs online, scoring real production traffic after you ship), **what unit** (final output vs the whole *trajectory* of steps and tool calls vs end-task success), and **what scorer** (deterministic code, an LLM-as-judge, or a human). Mature teams run offline evals in CI as a release gate and online evals on sampled production traces as a drift detector; the two are complementary, not competing.

**The awkward first question.** `DESIGN_DOC.md` §2.2 lists "**model-level observability** — inference latency, **prompt evaluation**, model drift, RAG quality" as an explicit non-goal, "out of scope by design; that's a different product." Read literally, evals are already excluded. That reading is right for one interpretation of evals and wrong for another, and the distinction is the whole content of this document:

- **Evaluating the model/agent** ("is Opus 5 better than Codex at this task?") — genuinely a different product. Stay out. It needs a runner, a sandbox, a task suite, and counterfactual re-runs, none of which an observe-only telemetry platform has or should grow.
- **Evaluating the org's real agent usage against real outcomes** ("do high-friction sessions actually produce worse code?") — that is *already this product's mission statement*, and it is already being done here, badly. `friction_score` and `shape_label` are evals. They are heuristic scorers, shipped to three audiences, version-pinned, driving alerts and coaching recommendations — **and never once validated against an outcome or a human label.**

**The headline finding.** This platform holds something almost no eval vendor has: **an outcome oracle**. Braintrust, Langfuse, Phoenix, and LangSmith score traces that have no ground truth, which is exactly why they lean so hard on LLM-as-judge. This platform's traces terminate in `pull_requests.merged_at`, `reverted_at`, `pr_ci_status`, `pr_review_decision`, `pr_check_runs`, and (via `jira_issues`) defect tickets. Those are hard labels arriving for free, weeks after the session, on real work. That inverts the normal eval problem: instead of needing a judge to guess quality, this platform can **use outcomes to validate scorers** — including the ones it already ships.

**Top 3 highest-value, lowest-cost moves:**

1. **A generic, versioned `scores` table.** Today every computed signal is a hard-wired column on `sessions` (`friction_score`, `shape_label`, `total_response_ms`) with no scorer identity, no version, no provenance, and no place to put a second opinion. One `scores` table — `(subject_type, subject_id, scorer_name, scorer_version, value, label, rationale_ref, cost_usd, created_at)` — is the keystone primitive. Every recommendation below reduces to "write rows into it."
2. **Validate the heuristics that already ship.** Build a gold set of a few hundred human-labelled sessions, then measure whether `friction_score` and `shape_label` predict anything real (revert rate, CI failure, review churn, the developer's own `SessionFeedback` sentiment). Publish the calibration next to the number. This is pure eval discipline applied to the product's own claims, it needs no judge, no new capture, and it is the cheapest credibility this platform can buy. P11-004 (Fisher's exact on friction-band deltas) already started down this path.
3. **Deterministic trajectory metrics from the events table.** Retry loops, edit-thrash, redundant re-reads, denial-retry-succeed patterns, tests-run-before-merge. The 2026 consensus is explicit that tool-call correctness should be measured deterministically and judges reserved for nuance — and every input is already in the hypertable. No LLM, no privacy exposure, no per-token cost.

**The thing to be most careful about.** LLM-as-judge over transcripts is the obvious flashy move and the one most likely to kill the product. It means an LLM reading developers' conversations to assign them quality scores, in a platform whose entire political premise is `share_transcripts_with_team = false` by default. There is a safe version of it (opt-in only, aggregate-only output, audit-logged, never a per-developer score visible to a manager) and an adoption-ending version, and they look similar in a sprint plan.

---

# Part 1 — What LLM Evals Are (Research)

> Source confidence flagged throughout: **first-party** (vendor/primary docs), **peer-reviewed / preprint**, and **practitioner** (blogs, vendor marketing — directional, not measured). Much of the 2026 eval literature is vendor content marketing; numbers from those sources are treated as heuristics, not measurements.

## 1.1 The three axes

**Axis 1 — When: offline vs online.**

*Offline* evaluation runs a fixed dataset of inputs through the system in a controlled batch and scores outputs against known expectations. It is reproducible, belongs in CI, and answers "did this change make things better or worse?" Its limitation is structural: it tells you the agent did not get worse on *yesterday's* tasks, and cannot anticipate inputs you have not seen, multi-turn drift, or tool failures that only occur against live systems.

*Online* evaluation scores real traffic as it arrives or shortly after, with no ground truth available up front. It catches drift and unanticipated edge cases. Its limitation is cost and latency — an LLM judge is too slow and too expensive to run on every turn, so online eval is either sampled, batched after the fact, or served by a small distilled classifier ([Offline vs Online LLM Evaluation](https://qaskills.sh/blog/offline-vs-online-llm-evaluation-2026); [LangChain: LLM Evals](https://www.langchain.com/resources/llm-evals) — practitioner).

**Axis 2 — What unit: output, trajectory, or task.**

For a single-shot LLM call, scoring the output text is the whole job. For an *agent*, it is close to worthless: when an agent writes code, runs shell commands, installs packages, and edits a filesystem, scoring the final message tells you almost nothing about whether it worked. Agent evaluation therefore looks at the **trajectory** — the sequence of steps, tool calls, and decisions ([Langfuse: AI agent evaluation](https://langfuse.com/resources/engineering/ai-agent-evaluation); [Confident AI: agent evaluation metrics](https://www.confident-ai.com/blog/llm-agent-evaluation-complete-guide) — practitioner). The recurring metric set:

| Metric | What it measures | Natural scorer |
|---|---|---|
| **Task completion** | Did the run achieve the goal? | judge or outcome oracle |
| **Tool correctness** | Was the right tool called? | code (schema/allowlist) or judge |
| **Argument correctness** | Argument *recall* (missing required args) and *precision* (hallucinated extra args) — different sub-failures, measure both | code |
| **Step efficiency** | Steps taken vs the minimum needed; how much unnecessary evidence was collected | code |
| **Plan coherence** | Did the trajectory hold together, or thrash? | judge |
| **Safety / policy** | Did it stay within permitted actions? | code |
| **Cost & latency** | The budget dimensions | code |

Trajectory-level evaluation is also an active research area, not just a vendor pitch — e.g. [*Beyond the Final Answer: Evaluating the Reasoning Trajectories of Tool-Augmented Agents*](https://arxiv.org/pdf/2510.02837) (preprint).

**Axis 3 — What scorer: code, judge, human.**

The 2026 convergent advice is a hierarchy: **use deterministic code wherever the property is checkable** (tool called? args valid? step count under budget? tests run?), **reserve LLM-as-judge for genuinely nuanced dimensions**, and **use humans to calibrate the judges, not to score at volume** ([Arize: LLM-as-a-judge evaluators that hold up in production](https://arize.com/blog/how-to-build-llm-as-a-judge-evaluators-that-hold-up-in-production/); [DeepEval: LLM-as-a-judge](https://deepeval.com/blog/llm-as-a-judge) — practitioner/first-party).

## 1.2 LLM-as-judge: the operational reality

A judge is itself a model under test, and the literature is unusually consistent about what it takes to run one honestly:

- **Calibrate against human labels, iteratively.** Label a representative set, run the judge, review disagreements, revise criteria/examples, re-run on the same set *and a holdout*. Practitioner guidance converges on **500+ labelled cases** before trusting aggregate metrics ([FutureAGI: LLM-as-Judge best practices](https://futureagi.com/blog/llm-as-judge-best-practices-2026); [Zylos: judge patterns for agent evaluation](https://zylos.ai/research/2026-05-26-llm-as-judge-agent-evaluation-patterns/) — practitioner; treat the specific threshold as a rule of thumb, not a measurement).
- **Re-calibrate whenever anything moves** — judge model version, judge prompt, or the system under test. A judge silently drifting on a model upgrade produces a fake trend line.
- **Sample, don't score everything.** Common guidance: 5–20% of production traces plus 100% of errors and outliers, with sample rate and judge-model size as the two cost levers. Marginal coverage past ~20% rarely justifies the spend; distilled small judges run 10–50× cheaper than frontier judges, which are reserved for calibration and audits.
- **Known bias modes**: position bias, verbosity bias, self-preference (a judge favouring its own family's outputs), and score compression toward the middle of a rubric.
- **The minimum infrastructure** a serious judge pipeline needs: a judge-prompt registry, a runner over a sampled stream, a **scoring database**, a calibration job against the gold set, and a drift monitor. That list is worth re-reading in the context of §2 — this platform has none of it, and the scoring database is the piece everything else hangs off.

## 1.3 The coding-agent-specific picture

Coding agents are the hard case for evals, because correctness is executable. Public benchmarks (SWE-bench Verified, SWE-bench Pro, Terminal-Bench, SWE-Lancer) run agents in isolated containers against real repositories and grade by whether tests pass. They are the right tool for *ranking models and harnesses*, and the wrong tool for *understanding one org's engineering*:

- **Contamination.** Many SWE-bench issues predate model training cutoffs; analyses of the leaderboards report substantial fractions of "successful" patches involving solution leakage or passing only because the tests were inadequate ([Dissecting the SWE-Bench Leaderboards](https://arxiv.org/pdf/2506.17208) — preprint).
- **Narrow representativeness.** Python-only, library-shaped tasks; ambiguous or underspecified issues — i.e. most real tickets — are filtered *out* during dataset construction. Newer suites ([SWE-MERA](https://arxiv.org/html/2507.11059v3), [SWE-bench++](https://arxiv.org/html/2512.17419v1), [SWE-Lancer](https://arxiv.org/pdf/2502.12115) — preprints) exist precisely to address contamination and scope.
- **Wrong unit of analysis.** A leaderboard score says nothing about whether *your* team's sessions on *your* codebase with *your* skills and MCP servers are going well.

The org-relevant counterpart is the **agent-configuration eval**: does *our* skill / `CLAUDE.md` / MCP setup still make the agent behave? This is an emerging practice with real tooling — running the agent headlessly against a fixture workspace and asserting on the resulting files, with judges written *before* the skill as the specification ([MLflow: testing and refining Claude Code skills](https://mlflow.org/blog/evaluating-skills-mlflow/); [Promptfoo: evaluate coding agents](https://www.promptfoo.dev/docs/guides/evaluate-coding-agents/); [AI skill testing: your prompts need regression tests](https://blog.bgener.nl/blog/ai-skills-testing/) — first-party/practitioner). Note the shape: it requires **executing** the agent. Hold that thought for §3.3.

## 1.4 The tooling and standards landscape

| Tool | Licence / hosting | Posture |
|---|---|---|
| **Langfuse** | MIT, self-hostable (Postgres + ClickHouse + Redis) | trace-first; `scores` as a first-class generic object; golden-dataset workflows |
| **Braintrust** | closed; self-host on enterprise | eval-first; meters *scores* as the billable unit |
| **Arize Phoenix** | Elastic 2.0, self-hostable | OTel-native; trajectory evals |
| **LangSmith** | closed | trajectory evals, native to LangChain |
| **DeepEval** | Apache 2.0 | pytest-style, code-first, CI-oriented, 50+ metrics |
| **Promptfoo** | open source | config-driven; explicit coding-agent guidance |
| **OpenAI Evals** | MIT (hosted product retiring late 2026) | offline grading |

Two structural observations matter more than the feature grid:

1. **Everyone models scores generically.** The common denominator across these platforms is a score object attached to a trace/observation with a name, a value, a source (human / code / judge), and a comment. That is not a coincidence — it is what lets one system carry heuristic scores, judge scores, and human labels side by side and compare them.
2. **The standard is not settled.** OpenTelemetry's GenAI semantic conventions moved out of the main semconv repo in v1.42.0 (June 2026) onto their own cadence and, as of July 2026, **no GenAI span, event, metric, or attribute is marked Stable** — though the shape is converging on structured messages, first-class agent spans (`create_agent`, `invoke_agent`, `execute_tool`, …), and *an evaluation event* ([OTel: GenAI observability](https://opentelemetry.io/blog/2026/genai-observability/) — first-party; [state of the GenAI semantic conventions, July 2026](https://john-hodge.com/blog/opentelemetry-genai-semantic-conventions/) — practitioner). **Implication for this repo:** an eval-result shape is worth designing *toward* the emerging `gen_ai` evaluation event so a future OTel bridge is a mapping and not a migration — but pinning to it today would be pinning to a moving target.

**The production-traces-become-datasets loop** is the other near-universal pattern: filter production traces for negative feedback or low scores, curate those hard examples into a golden dataset, and every real failure becomes a regression test ([Langfuse: golden dataset evaluation](https://langfuse.com/resources/engineering/golden-dataset-evaluation); [Turning production logs into evaluation datasets](https://fireworks.ai/blog/Turning-Production-Logs-into-Evaluation-Datasets) — practitioner). This platform has the traces and the failure signal; §3 argues about whether it should own the loop.

---

# Part 2 — What This Project Does (Capability Review)

## 2.1 What it is

Self-hosted observability for AI coding agents: a hook binary on developer machines emits per-event telemetry (`apps/hook`, adapters for Claude Code, OpenCode, Codex), a Hono ingest service writes an events hypertable + session aggregates + redacted transcripts to S3 (`apps/ingest`), a GitHub App correlates work to PRs (`apps/github-app`), and a Next SPA serves three audiences (`apps/web`). Eleven phases are done. Three architectural invariants shape everything below:

- **Observe-only.** The platform is not in the agent's execution path and by design does not gate, block, or re-run anything (`DESIGN_DOC` §10.3a; the HITL assessment's central conclusion).
- **Trust-first.** `share_transcripts_with_team` / `_with_org` default **off**; every privileged view is audit-logged and visible to the subject; investigator access is time-boxed and approved. §8 calls the defaults "the political fault line of the project."
- **Agent-neutral.** Everything branches on `agent_type`; no user-facing string says "Claude."

## 2.2 What it captures that is eval-relevant

| Layer | Eval-relevant content |
|---|---|
| `events` (hypertable) | per-tool: name, category, `tool_input_hash`, in/out bytes, `tool_duration_ms`, `tool_exit_status`, `tool_was_denied`, `tool_was_interrupted`; `mcp_server`/`mcp_tool`; `subagent_type`; `skill_name`; `slash_command`; per-turn `model` + tokens + cost; `mode`; `notification_kind`; `turn_number`, `parent_event_id` |
| `sessions` | lifecycle + status + `end_reason`; `compaction_count`/`clear_count`; git context; **`friction_score`**, **`shape_label`**; `mode`; `total_response_ms`/`response_sample_count`; `redaction_flags`; `pr_ci_status`, `pr_review_decision` |
| outcome tables | `pull_requests` (`merged_at`, `reverted_at`, `revert_of_pr_number`, `review_count`, lines/files), `pr_check_runs`, `pr_reviews`, `pr_rollups` (`check_failures_count`, `cost_per_loc`), `session_commit_links`, `jira_issues` (type/status/epic/points/`business_value`) |
| human signal | `SessionFeedback` (per-session sentiment + note, from the developer) |
| content | redacted transcript JSONL in S3 + `transcript_index` FTS; a gated, no-go'd `embed-transcripts` pgvector spike |
| governance | `VisibilityPolicy`, `AuditLog`, `AccessGrant`, `AlertRule`/`AlertEvent`, `JobConfig` + a scheduler that already runs nightly compute jobs |

`events.turn_number` + `parent_event_id` + ordered tool rows means **the trajectory is already reconstructable per session**. That is the single most important fact in this section.

## 2.3 The evals this project already ships (without calling them that)

This is the part worth sitting with. The platform is not eval-free; it is full of unvalidated evals.

| Existing thing | What it actually is | Validation status |
|---|---|---|
| `friction_score` | a **heuristic composite scorer** (retries + denials + interrupts + abandonment) over a session trajectory, computed nightly, surfaced on `/me/insights`, team and org dashboards, used as a search facet and a coaching-recommendation driver | **none.** No gold set, no human labels, no predictive check. Its weights are asserted |
| `shape_label` | a **classifier** (exploratory / implementation / debugging / planning) over a tool histogram | **none.** No confusion matrix, no inter-rater agreement, no accuracy claim |
| `SessionFeedback` | a **human scorer** — per-session sentiment from the one person who knows the ground truth | collected; never used to check any computed score |
| `/org/quality` + P11-004 | outcome correlation with **Fisher's exact** significance testing on friction-band deltas | the one place the product already does statistical validation. This is the seed |
| `/org/models` routing recommendations | a **projection**: "you could save X by routing retrieval-only work to a cheaper tier" | P10-006 ("recommendation validation loop", `ready`, unstarted) is exactly a projected-vs-realized eval, including an outcome guard so a "saving" that raised friction/reverts is surfaced rather than celebrated |
| alert rules | **threshold scorers** over aggregates, with firing/resolving history | no false-positive/precision tracking |
| `/me/insights` recommendations | **prescriptive advice** derived from friction drivers | never checked against whether following it helped |

Two structural weaknesses follow directly:

- **No score provenance.** Scores are columns on `sessions`. There is no scorer name, no version, no timestamp of scoring separate from the session, no rationale, and no room for a second scorer to disagree. §12.7 already had to describe the effectiveness widgets as "version-pinned" — that's a schema gap being handled by convention.
- **No re-scoring story.** `compute-effectiveness` deliberately treats `shape_label IS NULL` as the "has this been scored" marker for idempotency, so a scored session **never re-enters the candidate set**. Improving the scorer therefore cannot re-score history without a bespoke backfill job — the same shape as the `backfill-redaction` and `compute-effectiveness-backfill` one-shots that already exist. This is exactly the operational pain a versioned scores table removes.

## 2.4 What this project structurally cannot do

Honest boundaries, because they kill several otherwise-attractive eval ideas:

1. **No re-runs, no counterfactuals.** Observe-only means there is no way to ask "what if Haiku had done this?" Every A/B is observational and confounded (developers who choose Opus choose it for harder tasks).
2. **No task specification.** Sessions have no stated goal in structured form. "Did it complete the task?" has no reference answer — only a transcript and a downstream outcome.
3. **Ground truth is delayed, partial, and coarse.** A merge is not correctness; a revert is not always a defect; many sessions never produce a PR at all.
4. **Transcript access is deliberately restricted.** Any judge that reads content runs into `share_transcripts_*` defaults being **off**. The available corpus for content-based eval is opt-in only, and that is a feature.
5. **The hook has a <10ms budget.** Nothing evaluative runs inline. All scoring is post-hoc, batch, server-side.
6. **CI-side agent runs are out of scope** today (`DESIGN_DOC` §13 Q8), and the doc already warns they "look different (no human prompts) and could distort aggregates."

---

# Part 3 — Where Evals Fit (Assessment)

## 3.1 Three candidate scopes, one clear fit

**A. Model / agent benchmarking** — "which model or agent is better?" **Do not build.** It requires a runner, sandbox, task suite, and re-runs; it is the explicit §2.2 non-goal; and public leaderboards already do it better. The platform's legitimate version of this question is the *observational* one it already answers at `/org/agents`: how do agents compare on real work, on cost, friction, and error rates — clearly labelled as observational, not a benchmark.

**B. Evaluating real sessions against real outcomes** — **the fit.** This is not an extension of the product; it is the product's stated purpose (§10.6: "dashboards must frame cost alongside outcome signals... or the tool gets optimized for the wrong thing") done rigorously instead of heuristically. Everything in §3.2 lives here.

**C. Offline eval harness for the org's agent configuration** (skills, `CLAUDE.md`, MCP servers, subagents) — **valuable, adjacent, and a different execution model.** Treated separately in §3.3.

## 3.2 The asset nobody else has

Restating the core argument, because it is the reason to do any of this:

> Eval platforms score traces that have **no ground truth**, which is why they lean on LLM judges — and then have to spend enormous effort calibrating those judges against human labels. This platform's traces terminate in **merged / reverted / CI-failed / review-requested / defect-ticketed**, arriving automatically, weeks later, on real work, already correlated by `session_pr_links` and `session_commit_links`.

Three consequences:

1. **Scorers can be validated, not just asserted.** "Does friction predict reverts?" is answerable *today* with a SQL query and a significance test — P11-004 proves the machinery exists.
2. **Judges can be validated cheaply.** A judge's output can be checked against outcomes, not only against hand labels — which is the expensive part of every judge pipeline in §1.2.
3. **The gold set builds itself.** Reverted PRs, CI-failed merges, abandoned high-cost sessions, and thumbs-down `SessionFeedback` are a naturally-curated hard-example set — precisely the production-failures-become-regression-tests loop from §1.4, except the failure labels arrive for free.

## 3.3 On the agent-config harness (scope C)

Real value: an org accumulates skills, `CLAUDE.md` files, MCP servers, and subagents that silently rot. Nobody knows if last week's `CLAUDE.md` edit made the agent worse. §15 of the design doc already wants this ("Skill quality feedback loop... skill authors get a dashboard"), and §3.9 of `OPPORTUNITIES.md` frames it as a DX-research surface.

But it requires **executing** the agent against fixtures — a CI-side runner, not a telemetry pipeline. The right architecture is *not* to grow an executor inside `apps/ingest`:

> Let the harness live wherever the config lives (a repo's CI), run the agent headlessly, and emit telemetry through **the existing hook contract** — the same batching, auth, and event shapes — tagged as a non-interactive eval run. The platform then stores, aggregates, and trends eval runs with zero new ingest architecture.

That requires one schema dimension the platform lacks and *already knows it will need*: a `run_kind` (`interactive` | `ci` | `eval`) on sessions and events, so eval runs never pollute the human aggregates (§13 Q8's exact concern) but can be trended, compared across config versions, and joined to the skills they exercise. **Adding that dimension is cheap now and expensive later** — it is the same "capture now, surface later" logic as §10.3.

My recommendation: **do not build the harness in this repo**; do add the `run_kind` dimension and make the ingest contract explicitly hospitable to it. If someone builds the harness later, it plugs in.

## 3.4 Recommendations

Ordered by impact-to-effort, in the house style. **R1 is a prerequisite for most of the rest.**

| | Recommendation | Effort | Why |
|---|---|---|---|
| **R1** | **Generic versioned `scores` table.** `(id, subject_type, subject_id, scorer_name, scorer_version, source: heuristic\|judge\|human\|outcome, value, label, rationale_ref, cost_usd, created_at)`. Migrate `friction_score`/`shape_label` to write rows (keep the columns as a denormalized "current" cache so no dashboard breaks). Design the field names toward the emerging OTel GenAI evaluation event without pinning to it | M | The keystone. Unlocks re-scoring, scorer comparison, judge results, human labels, and calibration — all in one place, with provenance |
| **R2** | **Gold set + calibration of the existing scorers.** Sample a few hundred sessions stratified by shape/friction band; have a human (or the session owner, via an extended `SessionFeedback`) label them; report `shape_label` accuracy/confusion and whether `friction_score` predicts revert / CI-failure / review churn / owner sentiment. Surface the calibration *next to the score* on `/me/insights` and the team/org distributions | M | Cheapest credibility available. Turns two asserted numbers into measured ones — or honestly retires them. Directly serves §10.6's presentation discipline |
| **R3** | **Deterministic trajectory scorers over `events`.** Retry loops (same `tool_input_hash` repeated), edit-thrash (same file edited *n*× in a session), redundant re-reads, denial→retry→success chains, tests-run-before-merge, step efficiency vs a per-shape baseline, MCP error rate per server. Write results as `scores` rows | M | Follows the §1.1 hierarchy: deterministic first. No judge cost, no content access, no privacy exposure. All inputs already stored |
| **R4** | **Outcome-linked scorer validation surface** (`/org/quality` extension). For each scorer, show its correlation with outcomes over time, with the existing significance testing. A scorer that stops predicting is a scorer to retire | S–M | Generalizes P11-004 from one metric to a framework. Makes scorer drift visible |
| **R5** | **Generalize P10-006 into a projection-validation pattern.** Any surface that makes a claim ("you'll save X", "do Y and friction drops") persists the projection and later reports realized-vs-projected with an outcome guard | M | P10-006 already specifies this for routing. The pattern is worth more than the instance — it is the anti-vanity-metric mechanism §10.5 asks for |
| **R6** | **`run_kind` dimension** (`interactive`/`ci`/`eval`) on sessions + events, excluded from human aggregates by default | S | Cheap now, expensive later (§3.3). Also resolves §13 Q8 |
| **R7** | **Opt-in LLM-as-judge over consented transcripts, aggregate-output only.** Batch, sampled (5–20% + 100% of outcome-negative sessions), a scheduler job alongside `index-transcripts`; strictly gated on `share_transcripts_with_*`; per-session judge output visible **only to the session owner**; team/org see aggregates with small-n suppression; every judge read audit-logged like any privileged access; judge prompt + model version recorded as `scorer_version` | L | The only way to get task-completion and plan-coherence labels. Also the highest-risk item in this document — see §4 |
| **R8** | **Judge calibration job.** Once R7 exists, a scheduled job comparing judge scores against the R2 gold set and against outcomes, with drift alerting via the existing alert engine | M | §1.2's minimum infrastructure; without it R7 is theatre |
| **R9** | **Skill / MCP effectiveness scoring.** Per `skill_name` and `mcp_server`: invocation volume vs downstream friction, tool-error rate, and PR outcome. The feedback loop §15 already wants | M | Turns the existing `/org/skills` and `/org/mcp` pages from usage counters into quality signals. Depends on R3 |

**Explicitly do not build:** model/agent benchmarking or any leaderboard framing; real-time or in-hook evaluation (the <10ms budget forbids it); per-developer "quality scores" exposed to managers; any judge over non-consented transcripts; an agent execution runner inside `apps/ingest`.

---

# Part 4 — Risks & Guardrails

1. **The surveillance failure mode is the existential one.** `OPPORTUNITIES.md` §5 already states the rule: *every new analysis surface must first answer "what does the individual developer get from this?"* An eval score is a quality judgement about a person's work in a way that a cost number is not. The guardrail is structural, not editorial: judge output about a session is **owner-visible by default**, aggregate-only above that, small-n suppressed, and never ranked across individuals. If leadership asks for a per-dev eval leaderboard, the answer is the same as for "% of code written by AI" (§10.5) — substitute an outcome measure that requires the code to survive review.
2. **A judge reading transcripts is a new privileged reader.** It must be modelled as one: gated on the same `VisibilityPolicy` flags, audit-logged, covered by the same retention and deletion (`run-deletions`, `sweep-retention`) paths. Judge rationales are derived content from redacted transcripts and inherit their sensitivity — they need the same S3/retention treatment, not a JSONB free-for-all.
3. **Scoring costs money, in a product whose whole point is watching AI spend.** A judge pass over transcripts is a real line item. Sampling (§1.2), a distilled/cheap judge model with frontier models reserved for calibration, and — non-negotiably — recording `cost_usd` per score so the platform's own eval spend appears in its own dashboards.
4. **Unvalidated scorers are worse than no scorers.** This is the risk that already exists today. Once a number appears on a team dashboard it acquires authority it has not earned. R2 is the fix, and shipping R7 before R2 would compound the problem rather than solve it.
5. **Correlation ≠ causation, on every surface.** No re-runs (§2.4) means every finding is observational and confounded by task difficulty. "High friction predicts reverts" may just mean "hard tasks are hard." Significance testing (P11-004) is necessary and not sufficient; presentation must say "associated with," never "causes."
6. **Standards churn.** OTel GenAI conventions are Development-status with no stabilization timeline (§1.4). Design toward the shape; do not adopt the wire format yet.
7. **Scope creep into a different product.** Every eval vendor in §1.4 wants to be the platform for *all* LLM evaluation. This project's defensible position is narrow and specific: **coding-agent sessions correlated to engineering outcomes.** An eval capability that stops being about that is scope creep wearing a roadmap hat.

---

# Part 5 — A Possible Phase Shape (For Discussion, Not a Commitment)

If this became a phase, the ordering that respects the dependencies above:

- **Workstream A — Substrate:** R1 (`scores` table + migration of existing signals), R6 (`run_kind`).
- **Workstream B — Deterministic scorers:** R3 (trajectory metrics), R9 (skill/MCP effectiveness).
- **Workstream C — Validation:** R2 (gold set + calibration), R4 (scorer validation surface), R5 (projection-validation pattern; supersedes/absorbs P10-006).
- **Workstream D — Judge (gated, only after C):** R7 (opt-in judge job), R8 (calibration + drift alerting).

Success criteria in the house style: *a developer can see why their friction score is what it is and how accurate that score has been; a team lead sees a distribution with a stated confidence, not a bare number; an org admin can see which computed signals still predict real outcomes and which have gone stale — and no individual's eval score is visible to anyone but them.*

A defensible smaller version: **A + C only.** Ship the scores substrate and validate what already exists, and stop. That alone fixes the credibility gap, needs no judge, no new privacy surface, and no new cost.

---

## 6. Open Questions

1. **Is scope B (§3.1) inside or outside the §2.2 "prompt evaluation" non-goal?** This document argues it is inside the product's mission and that the non-goal targets model-level evaluation — but that is a call for the owner, and if the answer is "outside," R2/R4 still stand on their own as validation of existing claims.
2. **Who labels the gold set?** Session owners labelling their own sessions is trust-preserving and cheap but biased; a DX researcher under the `investigator` grant model is more consistent but slower and consumes grant capacity.
3. **Is judge spend acceptable at all** in a cost-observability product, and does it come out of the platform's budget or the org's agent budget?
4. **Does the org actually want the config harness (§3.3)** — and if so, does it belong in this repo, in the skills repos it tests, or in a separate tool that reports here?
5. **Would per-session judge output visible only to the owner still feel like surveillance?** Worth asking developers before building, not after — the same way the HITL work was grounded in the permission-mode data before the dashboards were designed.

---

*Companion documents: [`DESIGN_DOC.md`](../../DESIGN_DOC.md) (canonical scope), [`OPPORTUNITIES.md`](../../OPPORTUNITIES.md) (§3.9, §4 — the opportunity ranking this would slot into), [`2026-06-30-human-in-the-loop-assessment.md`](./2026-06-30-human-in-the-loop-assessment.md) (the precedent for research → recommendations → implementation).*
