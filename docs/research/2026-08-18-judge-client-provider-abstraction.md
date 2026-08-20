# Judge Client: Provider Abstraction Assessment

**Date:** 2026-08-18
**Scope:** Whether the P13-009 judge client should adopt a library to abstract the model provider, and which of the 2026 TypeScript options fit.
**Status:** Research / assessment. Verdict is **no library**, with two spin-off findings that belong to other tasks.

---

## 0. TL;DR

**The abstraction already exists.** `JudgeModelClient` (`apps/ingest/src/lib/judge-client.ts`) is a three-field interface — `complete({revision, system, user}) → {text, usage}`. `AnthropicJudgeClient` is one implementation in ~130 lines of `fetch` with zero dependencies. Adding a second provider means writing a second class, roughly 80 lines. The question is never "how do we get a seam"; it is "does a library beat 80 lines".

**It does not.** Every candidate costs at least one of three things the judge specifically needs: no-tools by construction, per-provider usage semantics, or a lean dependency tree. The closest fit on features — Pi's `pi-ai` — is the worst on dependencies, because it is a *fan-in* of five vendor SDKs rather than an abstraction over them.

**Two findings worth keeping**, neither about the judge client:

1. `pi-ai` ships a maintained, partly auto-generated **model-pricing catalog**. `P12-010` just hand-filled six price tables, one of them Pi's own. That is a data-source opportunity.
2. **promptfoo** is the right shape for `P13-010` (judge calibration and drift), which is a dev/CI eval-harness problem rather than a runtime-client one.

---

## 1. What the judge client is protecting

Three properties, all load-bearing, all easy to lose in a refactor:

**No tools, by construction.** The judge reads arbitrary transcript content — untrusted by definition, and `JUDGE_SYSTEM_PROMPT_V1` says so explicitly to the model. It is therefore given no capability beyond returning text.

A distinction the source comment blurs and that decides this whole assessment: the file says the restriction is "a property of the transport rather than a convention at the call site." It is really a property of the **interface** — `complete()` has nowhere to put a tool. That matters because it means swapping `fetch` for a vendor SDK *inside* `AnthropicJudgeClient` preserves the property completely, while replacing `JudgeModelClient` with a library's `generateText()` does not.

**Per-provider usage semantics.** Every call's `cost_usd` is computed from provider usage and written into `scores`, which is audit-visible and feeds `/admin/jobs`' spend panel. `P12-010` (#113) just fixed a bug of exactly this shape: OpenAI and Google report one inclusive prompt total with cached tokens *inside* it, Anthropic reports four disjoint counts. `apps/ingest/AGENTS.md` now states the rule — normalize where the provider's semantics are known, and "if you find yourself adding an `if (agent === …)` here, the adapter is doing too little." A generic library is precisely where those semantics are *not* known.

**Provider-specific parameters as scorer identity.** `JUDGE_REVISIONS` binds `(promptVersion, model, params)` to an integer `scorerVersion`. Its params are Anthropic-specific — `effort: 'low'`, and the *recorded* fact that Haiku 4.5 does not accept `effort` at all. A lowest-common-denominator abstraction typically drops or renames such params, which would change what the judge *is* while leaving its version number unchanged.

---

## 2. The landscape, four categories

### 2.1 Agent / application frameworks — over-scoped

**Vercel AI SDK** (25+ providers, TypeScript-first, best-in-class types, native edge runtime), **LangChain.js** (50+ providers, LangGraph-first, Node-serverless oriented), **Mastra** (24k stars, model router across 40+ providers), **Google Genkit** (Firebase-oriented), **LlamaIndex.TS** (RAG-focused).

All bring an agent loop, tool calling, memory and streaming UI to serve one `POST /v1/messages` call. All take `tools` as a first-class parameter. Mastra is the best-built of them and still the wrong size.

### 2.2 Thin unified clients — right shape, wrong maturity

`litellmjs`, `multi-llm-ts`, `llm-ports`, `llm-sdk`. This is the category that matches the need in shape.

`llm-sdk` (hoangvvo) was the closest inspection target: unified `ModelResponse`, normalized usage across providers, agent library in ~500 LOC. It sits at **21 stars, labelled v0**. That is not a dependency to put under code that writes billing-relevant figures into an audit-visible table. The others are in similar territory, and none is smaller than the ~80 lines a second `JudgeModelClient` implementation costs.

### 2.3 Gateways — no dependency, wrong data path

**OpenRouter** (managed) and **LiteLLM proxy** (self-hosted) both need no code change beyond `baseUrl`, which the client already accepts as config. OpenRouter puts a third party in the path of every transcript, which cannot be reconciled with a feature built on per-user consent and audit rows. LiteLLM self-hosted keeps data on the network but adds Postgres + Redis + Docker to operate — considerable surface next to a 130-line file.

Worth noting the repo has already half-anticipated gateway naming: `P12-010` taught `computeCostUsd` to strip a leading `<provider>/` so `anthropic/claude-opus-5` prices as `claude-opus-5`.

### 2.4 Eval-specific tooling — the closest-sounding, the worst-fitting

This category deserves the most attention because LLM-as-judge is literally the use case, and it is the one that fits worst.

**Braintrust `autoevals`** ships prebuilt LLM-as-judge scorers (factuality, relevance, safety, summarization). It is OpenAI-first, and Anthropic routes through the **Braintrust Gateway** by default — the same third-party-in-the-path problem as OpenRouter. More fundamentally its scorers grade *outputs against references*; this platform grades a recorded agent session against a domain rubric (`task_completion`, `plan_coherence`). None of the shipped scorers applies.

**promptfoo** is fully open source, Node-native, supports Anthropic, and runs "100% locally — your prompts never leave your machine." But it is a CLI and test-harness for dev-time prompt evaluation and CI gating, not a runtime library for scoring production records nightly. Right tool, wrong task — see §4.

**BAML** (schema-first DSL, TypeScript codegen) targets the structured-output half. `parseJudgeVerdict` plus a closed Zod schema already covers that, and BAML would add a codegen step to the bun + Turbo pipeline.

The common thread: eval frameworks assume you are testing prompts against fixtures at development time. This platform scores real sessions in production, under consent, with cost recorded. Superficially the same words; structurally a different problem.

### 2.5 Pi's `pi-ai` — best on features, worst on dependencies

Pi is one of the seven agents this platform observes, and it drives telemetry through in-process TypeScript extension modules, so it is npm-native. It publishes its LLM layer separately, in three live MIT forks:

| Package | Version | Last publish | Direct deps |
|---|---|---|---|
| `@mariozechner/pi-ai` | 0.73.1 | 2026-05-07 | 11, incl. `openai`, `@anthropic-ai/sdk`, `@google/genai`, `@mistralai/mistralai`, `@aws-sdk/client-bedrock-runtime`, `chalk` |
| `@earendil-works/pi-ai` | 0.84.2 | 2026-08-14 | 11, same vendor-SDK set + OpenTelemetry |
| `@oh-my-pi/pi-ai` | 17.3.7 | 2026-08-18 | 5, all `@oh-my-pi/*` + protobuf |

On features it is the best match found: unified `complete()`/`stream()`, a normalized `AssistantMessageEventStream`, mid-session provider handoff that preserves thinking blocks and tool calls, TypeBox tool schemas, and unified cost calculation over input/output/cache usage.

Three reasons it is still a no:

**It is a fan-in of vendor SDKs, not an abstraction over them.** One Anthropic call would pull the OpenAI SDK, Google GenAI, Mistral and the AWS Bedrock runtime client into `apps/ingest`. This repo has 33 catalog entries and exactly two vendor SDKs (S3, Octokit). Adopting a "lighter than a vendor SDK" option that installs five of them inverts the posture the judge client exists to hold. `chalk` in the dependency list is the tell: built for a CLI, not a server.

**Version instability against a pinning policy.** 308, 576 and 41 published versions; `@mariozechner` sub-1.0 and three months stale; `@oh-my-pi` at major 17, shipping today. Every dependency here goes through a pinned root catalog specifically to avoid that churn.

**A conflict of interest.** Pi is one of the agents this platform measures. Running the judge that scores Pi sessions on Pi's own library couples the instrument to one of its subjects. Not fatal and not decisive on its own — but for a phase whose purpose is validating scorers against outcomes, it is cheap to avoid now and awkward to explain later.

---

## 3. Verdict

**Keep the hand-rolled client behind `JudgeModelClient`.**

The one option worth revisiting on its own merits is the **official `@anthropic-ai/sdk`** — single-provider, and safe *inside* the existing class per the interface/transport distinction in §1. It would replace hand-rolled refusal handling, content-block filtering and retries with maintained code that tracks API drift. It cuts against the repo's explicit "does not carry a vendor SDK" convention, so it is a real trade rather than a free win, and it is a separate decision from provider abstraction.

**If multi-provider is ever wanted, the argument is judge independence, not portability.** `P13-010` calibrates the judge against a human gold set; if the judge is Claude and the sessions are largely Claude Code, a second independent model yields inter-rater agreement across providers, which is a materially stronger calibration signal. That requirement is not live (P13-010 is blocked on DP-1), which is exactly why no dependency should be taken for it now.

The shape when it is: a second class implementing `JudgeModelClient`, plus a **`provider` field on `JudgeRevision`** — if the provider changes, the scorer's identity changes, and `scorerVersion` must capture that or two providers' verdicts blend into one series.

---

## 4. Spin-off findings

**A maintained model-pricing catalog (→ `P12-010`).** `pi-ai` maintains pricing metadata for hundreds of models, partly auto-generated from OpenRouter and the Vercel AI Gateway, and `@oh-my-pi/pi-catalog` publishes it separately (MIT, "bundled model database, provider discovery descriptors, model identity, classification"). `P12-010` found six of seven price tables wrong or empty — and `pi` was one of the four that shipped empty and billed everything at $0. So this repo hand-filled a price table for Pi while Pi ships a maintained catalog covering hundreds of models.

**Since acted on — see [`P12-012`](../../tasks/P12-012-generate-provider-agnostic-price-tables.md).** The three provider-agnostic tables are now generated from <https://models.dev/api.json>, the catalog opencode itself builds from, rather than from `pi-catalog`; 34 models across 3 vendors became 243 across 20. The reasoning below is why the direction was right, and the source chosen differs from the one it guessed at.

This is a **data-source** opportunity, not a dependency one. `apps/ingest/src/data/price-table.*.v1.json` is deliberately versioned JSON a human edits — the rule is "a price correction is a JSON edit plus a restart." Syncing or vendoring from a maintained catalog keeps that property while removing the hand-research that made six tables wrong. Check licence attribution and the catalog's shape first; `pi-catalog` itself carries three `@oh-my-pi/*` deps, so extract data rather than depend on it.

**promptfoo as a calibration harness (→ `P13-010`).** P13-010 is "run the judge against a gold set and measure agreement" — a dev/CI eval-harness problem, which is what promptfoo is built for, and it runs locally so the consent model survives. Worth evaluating when DP-1 unblocks the task, in place of hand-rolling an agreement harness.

---

## 5. Sources

- [LangChain vs Vercel AI SDK vs OpenAI SDK: 2026 Guide](https://strapi.io/blog/langchain-vs-vercel-ai-sdk-vs-openai-sdk-comparison-guide)
- [LangChain.js vs Vercel AI SDK (2026)](https://www.pkgpulse.com/guides/langchainjs-vs-vercel-ai-sdk-2026)
- [Mastra vs LangChain.js vs Google GenKit (2026)](https://www.pkgpulse.com/guides/mastra-vs-langchain-js-vs-genkit-2026)
- [Best TypeScript AI Agent Frameworks: AI SDK vs Mastra](https://www.ayautomate.com/blog/best-typescript-ai-agent-frameworks)
- [OpenRouter vs LiteLLM: Managed vs Self-Hosted Gateway](https://openrouter.ai/blog/insights/openrouter-vs-litellm/)
- [LiteLLM vs OpenRouter (2026)](https://www.truefoundry.com/blog/litellm-vs-openrouter)
- [llm-sdk](https://github.com/hoangvvo/llm-sdk)
- [promptfoo](https://github.com/promptfoo/promptfoo)
- [Braintrust autoevals](https://github.com/braintrustdata/autoevals)
- [pi-ai LLM Provider Abstraction](https://deepwiki.com/agentic-dev-io/pi-agent/3-llm-provider-abstraction-\(pi-ai\))
- [earendil-works/pi](https://github.com/earendil-works/pi)
- npm registry metadata for `@mariozechner/pi-ai`, `@earendil-works/pi-ai`, `@oh-my-pi/pi-ai`, `@oh-my-pi/pi-catalog` (queried 2026-08-18)
