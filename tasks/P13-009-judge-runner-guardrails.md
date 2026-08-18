---
id: P13-009
title: Judge runner + guardrails (own transcripts only)
phase: 13
workstream: D
status: done
owner: claude
depends_on: [P13-001]
blocks: [P13-010, P13-011]
estimate: L
---

## Goal

Build the LLM-as-judge runner — sampled, batched, scheduler-run — with consent gating,
audit writes, owner-only display, a versioned prompt registry, and per-score cost
recording as **acceptance criteria rather than follow-ups**. Exercised only against
the operator's own sessions and seed data; pointing it at anyone else's transcript is
[`P13-011`](./P13-011-arm-judge-for-other-users.md).

## Context

See [`P13-roadmap.md`](./P13-roadmap.md) and
[`docs/research/2026-08-12-llm-evals-assessment.md`](../docs/research/2026-08-12-llm-evals-assessment.md)
§1.2 and §3.4 (R7). A judge is the only way to get labels for "did this session
accomplish the task?" and "did the plan hold together?" — dimensions no metadata
scorer can reach.

**Why this is `ready` when the assessment argued for gating it.** The assessment's
gate assumed a live deployment full of other people's transcripts. With seed-only data
and no rollout, there is no third party whose conversation could be read, so the
*engineering* carries none of the risk that the *arming* does. The split follows: build
the runner and its guardrails now, gate the irreversible act separately. The guardrails
are in this task, not the next one, because consent gating and audit writes are exactly
the things that never get retrofitted into a job whose queries were written without
them — "we'll add it at rollout" is how they end up not existing.

The infrastructure a serious judge needs (assessment §1.2): a judge-prompt registry, a
runner over a sampled stream, a scoring database (P13-001), a calibration job
(P13-010), and a drift monitor (P13-010).

## Acceptance criteria

- [x] The candidate-session query returns **only** sessions whose owner is the
      operator running the job, or whose owner has opted in via `VisibilityPolicy`.
      A session outside that set is never fetched, never decompressed, and never sent
      to a model.
- [x] The consent check runs **twice** — at candidate selection and again at fetch —
      so a session selected before a policy change is not judged after it. Verified by
      a test that revokes consent between the two points.
- [x] Until [`P13-011`](./P13-011-arm-judge-for-other-users.md) lands, an explicit
      config gate restricts the runner to the operator's own sessions **in addition
      to** the consent check. Two independent guards, and the test suite asserts that
      removing either one still blocks a third party's transcript.
- [x] Every transcript read writes an `AuditLog` row visible to the subject in their
      own audit feed, exactly like any other privileged access (`DESIGN_DOC.md` §8.3).
- [x] Judge output for a session is visible **only to the session owner**. No team or
      org surface reads it in this task.
- [x] The judge prompt lives in a versioned registry; the
      `(prompt version, model, parameters)` triple is recorded as `scorer_version` on
      every score. A prompt or model change writes new-version rows and never mutates
      existing ones.
- [x] `cost_usd` is recorded per score and judge spend surfaces in the platform's own
      cost views. A cost-observability product must show its own eval spend.
- [x] Sampling is configurable, defaults low (5–20%), and always includes
      outcome-negative sessions (reverted PR, CI-failed, abandoned high-cost).
- [x] Rationales are stored **by reference** (`rationale_ref`), under the same
      retention (`sweep-retention`), deletion (`run-deletions`), and redaction
      guarantees as the transcripts they derive from.
- [x] The job is registered in `scheduler.ts`, configurable from `/admin/jobs`, and
      **off by default** on a fresh deployment.
- [x] The judge is given **no tools**, and its output is parsed against a constrained
      schema. Transcripts contain arbitrary user and tool content, so the judge is a
      model consuming untrusted input — its output is data, never instructions.
- [x] Nothing judge-related touches the hook or the ingest request path.

## Implementation notes

- Two rubric dimensions is enough for a first pass: task completion and plan
  coherence. Resist a rich rubric — every dimension is more calibration surface and
  another way to be confidently wrong.
- Write the rubric before the runner. The rubric is the specification, and writing it
  first tends to reveal that the intended dimension was underspecified.
- Model choice should be configuration, not a constant: a small/cheap judge for the
  sampled stream, with a frontier model reserved for the calibration runs in P13-010.
  The cost differential is the main lever. Per repo convention, the provider config
  belongs in the service's Zod-validated `loadConfig()` and nowhere else.
- Reuse the transcript-reading path from `index-transcripts` rather than writing a
  second S3 fetch/decompress; it already handles the redacted-content contract.
- Agent-neutral: the rubric must not assume a specific agent's transcript format
  beyond what `packages/schemas` normalizes.

## Files touched

- `apps/ingest/src/jobs/judge-sessions.ts` (+ test), `apps/ingest/src/jobs/scheduler.ts`
- `apps/ingest/src/config.ts` (judge provider/model config)
- `packages/schemas/src/judge.ts` (+ test) — rubric, output schema, scorer names
- `apps/web/src/app/me/sessions/[id]/page.tsx` (owner-only display)
- `apps/web/src/app/admin/jobs/page.tsx`

## Out of scope

- Judging **anyone else's** transcript, consented or not. That is P13-011, and the
  two-guard requirement above exists to make it impossible from this task alone.
- Any team or org surface for judge output.
- Using judge output in `friction_score`, any composite, any recommendation, or any
  alert — nothing consumes it until P13-010 has calibrated it.
- Real-time or per-turn judging. Batch and sampled only.
- Judging transcripts to build the P13-007 gold set. Circular.

## Verification

```bash
bun install
bun --filter '@ai-agents-observability/schemas' test judge
bun --filter '@ai-agents-observability/ingest' test judge-sessions
bun run check
bun run typecheck
bun run build
bun run test
```

## Why the client is hand-rolled

Assessed 2026-08-18 against the 2026 TypeScript landscape — Vercel AI SDK,
LangChain.js, Mastra, Genkit, LlamaIndex.TS, the thin unified clients
(`litellmjs`, `multi-llm-ts`, `llm-sdk`), the gateways (OpenRouter, LiteLLM),
the eval frameworks (Braintrust `autoevals`, promptfoo, BAML), and Pi's own
`pi-ai`. Full write-up: [`docs/research/2026-08-18-judge-client-provider-abstraction.md`](../docs/research/2026-08-18-judge-client-provider-abstraction.md).

Verdict: **no library.** `JudgeModelClient` is already the seam, and a second
provider is a second ~80-line class implementing it — cheaper than any candidate.
Each candidate costs at least one of three things this task's guardrails depend on:

- **No tools, by construction.** Every general abstraction takes `tools` as a
  first-class parameter. One clarification the client's own comment blurs: the
  restriction is a property of the **interface** (`complete()` has nowhere to put
  a tool), not of `fetch`. So swapping in a vendor SDK *inside*
  `AnthropicJudgeClient` keeps the property; replacing `JudgeModelClient` with a
  library's `generateText()` does not.
- **Per-provider usage semantics.** `cost_usd` on every score row is computed
  from provider usage. P12-010 fixed exactly this class of bug — OpenAI and
  Google report an inclusive prompt total, Anthropic four disjoint counts — and
  `apps/ingest/AGENTS.md` now requires normalizing where the semantics are known.
- **Provider-specific params as identity.** `JUDGE_REVISIONS` binds
  `effort: 'low'` (and Haiku 4.5's *absence* of `effort`) into `scorerVersion`.
  A lowest-common-denominator abstraction drops those while the version number
  stays put.

`pi-ai` was the closest fit on features and the worst on dependencies: it is a
fan-in of five vendor SDKs (`openai`, `@anthropic-ai/sdk`, `@google/genai`,
`@mistralai/mistralai`, `@aws-sdk/client-bedrock-runtime`) rather than an
abstraction over them. It also observes-the-observer — Pi is one of the seven
agents this platform measures.

Open, and separable: adopting the official `@anthropic-ai/sdk` **inside**
`AnthropicJudgeClient`. Single-provider, structurally safe, and it would replace
hand-rolled refusal handling and content-block filtering with maintained code —
against the repo's "no vendor SDK" convention. A real trade, not a free win.

## Implementation record

Landed. Notes for a reviewer, in the order they are most worth checking:

- **The two guards are not symmetric, deliberately.** Consent
  (`visibility_policies.allow_judge_analysis`) is a new column, not a reuse of
  `share_transcripts_with_org`: deriving "a model may grade this" from "my org
  admin may read this" would have granted the second consent to everyone who
  ever gave the first. The own-sessions guard is a **code constant**
  (`JUDGE_OWN_SESSIONS_ONLY` in `apps/ingest/src/jobs/judge-sessions.ts`), not an
  environment variable, so no deployment configuration can aim the runner at a
  third party — which is what makes P13-011 a reviewed code change rather than a
  value someone sets at 3am. `apps/ingest/test/judge-sessions.test.ts` asserts
  each guard blocks a third party with the other neutralized, and that consent
  revoked between selection and fetch blocks the read.
- **`scorer_version` is resolved, not constant.** A judge's identity is its
  `(prompt version, model, parameters)` triple, and the model is configuration,
  so a static `SCORERS` version could not express it. `JUDGE_REVISIONS`
  (`packages/schemas/src/judge.ts`) binds each triple to an integer, `ScoreInput`
  gained an explicit `scorerVersion` override for this one case, and a
  configured model with **no** registered revision leaves the judge disabled
  rather than scoring under a borrowed number. Adding a model or editing the
  prompt is an append to that registry.
- **Cost is split across the two rows.** One model call produces both labels, so
  each row carries half its cost — a cost view that sums `scores.cost_usd` then
  reports the true judge spend instead of double-counting it.
- **The provider client is hand-rolled `fetch`**, matching
  `AnthropicBillingSource`, rather than adding a vendor SDK to the pinned
  catalog. The judge's "no tools" property is therefore structural: the client
  has no parameter that could carry one. It also sends no sampling parameters
  (current models reject them) and treats `stop_reason: "refusal"` as no verdict.
- **Rationales are S3 objects under `judge-rationales/`**, not under
  `transcripts/` — the retention job's orphan sweep deletes anything under that
  prefix it cannot match to a session, and a rationale would look exactly like an
  orphan. They are redacted before the write, purged when the transcript they
  derive from is swept, and purged before the score rows on a GDPR deletion.
- **Owner-only display is checked by a source lint**
  (`apps/web/test/judge-owner-only.test.ts`), in the same spirit as the run-kind
  and blinding lints: a team or org surface that starts reading a judge scorer
  has to delete a failing test to exist.

Two things a reviewer should push on:

- The runner has **never been executed against the real API** in this
  environment. The request shape follows the current Messages API
  (`max_tokens`, `system`, one user turn, optional `output_config.effort`, no
  `tools`, no sampling parameters), and the client is unit-tested against a
  stubbed `fetch` — but the first real call is still unproven. Exercise it with
  `POST /admin/jobs/judge-sessions/run` against one own session before enabling
  the schedule.
- The verdict is parsed from **text**, not requested via structured outputs. That
  was a robustness call — a wrong `output_config.format` shape is a 400 at run
  time, whereas a strict Zod parse of text degrades to "no score written" — but
  structured outputs would be the stronger contract once the shape is confirmed
  against a live endpoint.
