# Human-in-the-Loop (HITL): Research & Capability Assessment

**Date:** 2026-06-30
**Scope:** Research on what HITL is and its best practices, plus an assessment of where `ai-agents-observability` stands today and what would bring the most value.
**Status:** Research / assessment. **The recommendations below (R1–R12) were subsequently implemented** in the same PR — see "Implementation status" under §0 and the per-recommendation tags. The research and rationale are retained as written.

> **Implementation status (added post-research).** All twelve recommendations landed: R1 capture autonomy mode · R2 classify notifications (+ `permission_prompt_count`) · R3 response latency · R4/R5 Oversight & Autonomy panel + rubber-stamp detector (`/me` + `/team` + `/org`) · R6 mode search facet · R7 alert acknowledge + rule silence/snooze · R8 needs-attention grant queue + bulk approve · R9 autonomy-surge alert rule · R10 AI-authored-code provenance (`/org/governance`) · R11 per-session human feedback · R12 governance & oversight-posture report. The "observe-only" framing (§2.1) held: nothing here intercepts a live tool call. Real-time tool approval / remote session-stop remain deliberately unbuilt (§2.4).

---

## 0. TL;DR

**What HITL is.** "Human-in-the-loop" describes *how tightly a human is coupled to an autonomous system's decisions*. It is a spectrum, not a binary: **in the loop** (the action cannot proceed without explicit human approval), **on the loop** (the system acts autonomously while a human monitors and can abort), and **out of the loop** (full autonomy). For AI coding agents this shows up concretely as permission prompts, plan-approval gates, auto-accept-edits, allow/deny lists, sandboxes, and "waiting for your input" notifications — and *every* mainstream agent (Claude Code, Cursor, Copilot, Codex, OpenCode, Aider) ships both a graduated set of these gates and a "YOLO" escape hatch.

**Where this product sits.** This is an **observability** platform — it ingests telemetry *after the fact*; it is **not in the agent's execution path**. So it cannot (and by design should not) *be* the human gate that approves or denies a tool call — Claude Code already does that on the developer's machine. Its HITL value is different and arguably more durable: **make the oversight that is already happening visible, measurable, and improvable** across individuals, teams, and the org. Think "flight-data recorder for human↔agent oversight," not "the cockpit." This is exactly the niche peer tools (LangSmith, Langfuse, Datadog, Arize Phoenix) are racing to fill — and they're doing it for general LLM apps, not for *coding-agent* telemetry correlated to PRs, which is this product's moat.

**Why this matters now (the empirical case).** Oversight fatigue is not hypothetical. Anthropic's own Claude Code data: users **approve 93% of permission prompts**, which it explicitly calls "approval fatigue, where people stop paying close attention to what they're approving" ([Anthropic: auto mode](https://www.anthropic.com/engineering/claude-code-auto-mode)). Full auto-approve adoption **rises from ~20% to >40% of sessions as users gain experience** ([Anthropic: measuring agent autonomy](https://www.anthropic.com/research/measuring-agent-autonomy)). And peer-reviewed work shows **more human review is *not* monotonically safer** — realized safety follows an inverted-U against escalation rate ([arXiv: "Oversight Has a Capacity"](https://arxiv.org/html/2606.08919v1)). A tool that can *measure* where teams sit on these curves has a real, defensible reason to exist.

**Headline finding.** The product already captures most of the *raw signal* needed to be a strong HITL-observability tool — `Notification` events, permission-prompt and permission-deny counts, interrupts, tool denials, a friction score that weights denials/interrupts, an alert engine, time-boxed access grants, and a pervasive audit log. But the two most important HITL signals are **captured-but-discarded or never captured**, and there is **no surface that frames any of it as "oversight / autonomy."**

**Top 3 highest-value, lowest-cost moves:**

1. **Capture the agent's permission/autonomy mode.** `session_context.mode` exists in the schema but every adapter hardcodes it to `'normal'` ([apps/hook/src/lib/payload.ts:171](../../apps/hook/src/lib/payload.ts), [opencode.ts:119](../../apps/hook/src/adapters/opencode.ts), [codex.ts:83](../../apps/hook/src/adapters/codex.ts)). Without it the platform **cannot tell a heavily-supervised `plan`-mode session from a `bypassPermissions` "YOLO" run** — the single most important HITL dimension, and the one Anthropic itself uses to measure autonomy trends. This is the keystone gap.
2. **Classify `Notification` events.** Claude Code's notification payload (which says *why* it is interrupting — "waiting for your input," "needs permission," "task finished") is preserved verbatim in the event `metadata` JSONB but **never parsed**. A small classifier turns it into a first-class signal: how often agents block on humans, and how long humans take to respond.
3. **Add an "oversight & autonomy" lens to the dashboards** — built almost entirely from data already stored (denial rates, interrupts, friction), with autonomy-mode mix and response latency once #1/#2 land. Include a **rubber-stamp / approval-fatigue detector** — the single most novel and defensible insight available, directly backed by Anthropic's 93% datapoint and the oversight-capacity literature.

The rest of this document supports those conclusions.

---

# Part 1 — What Human-in-the-Loop Is (Research)

> Source confidence is flagged throughout: **first-party** (vendor/primary docs), **peer-reviewed**, **standards/legal** (primary text), and **practitioner** (blogs/heuristics — directional, not measured). Several numeric heuristics come from single practitioner sources and are marked as such.

## 1.1 Definitions and the autonomy spectrum

The "in / on / out of the loop" taxonomy comes from the autonomous-weapons-systems debate — popularized by Bonnie Docherty's 2012 Human Rights Watch report *Losing Humanity*, and the loop language entered U.S. federal law via the FY2025 NDAA's "positive human action" requirement for nuclear-weapons decisions ([Wikipedia: Human-in-the-loop](https://en.wikipedia.org/wiki/Human-in-the-loop)).

| Mode | Coupling | One-line definition |
|---|---|---|
| **Human-in-the-loop (HITL)** | Tightest | The system **cannot complete an action** until a human takes positive action to authorize it. Prioritizes control over speed. |
| **Human-on-the-loop (HOTL)** | Supervisory | The system **acts autonomously** while a human monitors and **retains the ability to abort/override**. The "kill-switch" model; operates at machine speed. |
| **Human-out-of-the-loop** | None | Full autonomy: once started, the system acts with no further human intervention. |

Sources: [Wikipedia](https://en.wikipedia.org/wiki/Human-in-the-loop); [TekLeaders: HITL vs HOTL](https://tekleaders.com/human-in-the-loop-vs-human-on-the-loop-agentic-ai/); [n8n](https://blog.n8n.io/human-in-the-loop-vs-human-on-the-loop/).

A second lineage comes from **MLOps**, where HITL means integrating human feedback/annotation into the model lifecycle — canonically via *active learning*, where the model flags low-confidence cases and asks a human only where needed ([Google Cloud](https://cloud.google.com/discover/human-in-the-loop)). Modern *agentic* HITL is a synthesis of the two: the **military spectrum** (degrees of control) plus the **MLOps mechanic** (human as approver/feedback-provider at runtime checkpoints).

**Autonomy is a dial, not a switch.** Multiple practitioner and academic taxonomies model agent autonomy on the SAE J3016 self-driving levels (L0–L5), framing rising autonomy as a progressive transfer of responsibility, and naming the human's role at each level — *operator → orchestrator → supervisor/approver → onlooker/observer* ([Falconer](https://seanfalconer.medium.com/the-practical-guide-to-the-levels-of-ai-agent-autonomy-ac5115d3af26); [Data Agents L0–L5](https://techlife.blog/posts/data-agents/); [Vellum](https://www.vellum.ai/blog/levels-of-agentic-behavior); [Swarmia: 5 levels of AI agent autonomy](https://www.swarmia.com/blog/five-levels-ai-agent-autonomy/)). There is **no single agreed taxonomy** — several competing L0–L5/L6 schemes coexist — but they agree on the through-line: **as autonomy rises, the human moves from doing the work, to approving each step, to spot-checking outcomes.** Crucially, "higher isn't always better" (Swarmia) — the right level is the one calibrated to the task's risk.

## 1.2 How HITL shows up in AI coding agents (cross-tool survey)

The generic agentic HITL pattern for tool use: *the agent decides to call a tool → execution pauses → the proposed call (name + arguments) is surfaced to a human → the human approves/rejects → the agent proceeds or takes the rejection as context* ([Microsoft Agent Framework: tool approval](https://learn.microsoft.com/en-us/agent-framework/agents/tools/tool-approval); [LangChain HITL middleware](https://docs.langchain.com/oss/python/langchain/human-in-the-loop), which formalizes four decision types — *approve / edit / reject / respond*).

Every mainstream coding agent implements this with different knobs, but the shape is strikingly consistent — **graduated gates + a sandbox layer + a YOLO escape hatch**:

| Agent | HITL gating mechanism | "YOLO" escape hatch |
|---|---|---|
| **Claude Code** | Permission **modes** (`default` → `acceptEdits` → `plan` → `bypassPermissions`/`auto`), allow/deny/**ask** rules, `PreToolUse` hooks (can allow/deny/ask/modify), OS sandbox (bubblewrap/Seatbelt) + auto-mode classifier | `--dangerously-skip-permissions` / `bypassPermissions` |
| **Cursor** | Agent vs **Plan Mode**, "Run Mode" for terminal, allowlist + sandbox + classifier ("Auto-review" default tier) | "Run Everything" (formerly "YOLO") |
| **GitHub Copilot** | VS Code agent mode: per-tool confirmation, tiered autonomy, `chat.tools.terminal.autoApprove` allow/deny lists, OS sandbox; cloud agent opens a **draft PR for human review** | `chat.tools.autoApprove` / "Autopilot" |
| **OpenAI Codex** | `--ask-for-approval` (`untrusted`/`on-request`/`never`) × `--sandbox` (`read-only`/`workspace-write`/`danger-full-access`) | `--dangerously-bypass-approvals-and-sandbox` / `--yolo` |
| **OpenCode** | Per-action `permission` config resolving to `allow`/`ask`/`deny`, wildcard patterns, per-agent overrides; `.env` denied by default | global `"*": "allow"` |
| **Aider** | **Reversal-based**, not gate-based: auto-applies + auto-commits edits, relies on git `/undo` + history; confirmation prompts for adding files / running shell | `--yes-always` |

Sources: [Claude Code settings](https://code.claude.com/docs/en/settings) / [hooks](https://code.claude.com/docs/en/hooks) / [permission modes](https://code.claude.com/docs/en/permission-modes); [Cursor modes](https://cursor.com/docs/agent/modes) / [terminal](https://cursor.com/docs/agent/terminal); [VS Code Copilot agents](https://code.visualstudio.com/docs/copilot/agents/overview) / [cloud coding agent](https://docs.github.com/copilot/concepts/agents/coding-agent/about-coding-agent); [Codex CLI reference](https://developers.openai.com/codex/cli/reference) / [approvals & security](https://developers.openai.com/codex/agent-approvals-security); [OpenCode permissions](https://opencode.ai/docs/permissions/); [Aider git](https://aider.chat/docs/git.html).

**Two design lessons for this product:**

1. **Edit-application spectrum.** Most agents gate edits/commands *before* execution (approval-based safety); Aider auto-applies and relies on git reversibility (reversal-based safety). An observability tool needs to understand both models — friction-from-denials means little for Aider, where the safety signal is `/undo` and revert rate.
2. **The whole spectrum is expressed through modes + hook events** — exactly the telemetry this platform ingests. Claude Code's permission evaluation order is **Hooks → Deny → Ask → Mode → Allow → `canUseTool`**, and `PreToolUse` hooks run first and can deny even under `bypassPermissions`; `ask` rules force a prompt even under bypass ([Agent SDK: permissions](https://platform.claude.com/docs/en/agent-sdk/permissions)). The mode is also adjustable mid-session (`setPermissionMode`) — "start restrictive, loosen as trust builds." The signal is right there in the wire format.

## 1.3 Best practices (what good HITL looks like)

Synthesized from standards, first-party engineering writing, peer-reviewed human-factors science, and practitioner sources. The convergent points are flagged.

1. **Gate by side-effect and risk, not uniformly.** Require approval for tools with **write semantics** (create/modify/delete/deploy/send/transact); auto-run read-only tools with no real-world effect ([Permit.io](https://www.permit.io/blog/human-in-the-loop-for-ai-agents-best-practices-frameworks-use-cases-and-demo)). Claude Code's own auto-mode classifier formalizes this in three tiers: Tier 1 (reads/search/navigation) auto-approved; Tier 2 (in-project edits) allowed and left to VCS review; Tier 3 (shell, external integrations, out-of-project writes) sent to a classifier ([Anthropic: auto mode](https://www.anthropic.com/engineering/claude-code-auto-mode)).
2. **Calibrate to reversibility × blast radius.** The dominant production heuristic gates on **irreversibility, blast radius, compliance exposure, and confidence**; approval becomes mandatory when the next action is irreversible, costly, regulated, or high-blast-radius ([digitalapplied](https://www.digitalapplied.com/blog/human-in-the-loop-escalation-design-ai-agents-2026); [StackAI](https://www.stackai.com/insights/human-in-the-loop-ai-agents-how-to-design-approval-workflows-for-safe-and-scalable-automation)). OpenAI's agent guide says the same: gate "sensitive, irreversible, or high-stakes" actions, especially early in deployment ([OpenAI: practical guide to building agents](https://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents/)).
3. **Confidence scores are not a sufficient gate.** Self-reported confidence is miscalibrated and errors compound across multi-step chains; tier by *action consequence*, not confidence alone ([digitalapplied](https://www.digitalapplied.com/blog/human-in-the-loop-escalation-design-ai-agents-2026) — note: the specific percentages there are illustrative, not measured).
4. **Two gate types: *required* (blocking) vs *audit* (non-blocking, logged).** Use blocking gates for high-stakes ops, audit gates for the long tail ([Permit.io](https://www.permit.io/blog/human-in-the-loop-for-ai-agents-best-practices-frameworks-use-cases-and-demo)). Three controls always matter — **approvals, permissions, audit trails** (*who approved it, what could it do, what happened after*) ([TeamCopilot](https://teamcopilot.ai/blog/human-in-the-loop-ai-agents-approvals-permissions-audit-trails)).
5. **Enforce the gate *outside* the agent's reasoning,** at the workflow layer — don't let the controlled component negotiate its own controls ([digitalapplied](https://www.digitalapplied.com/blog/human-in-the-loop-escalation-design-ai-agents-2026)).
6. **Defense in depth around the human gate:** least-privilege + sandbox (filesystem *and* network isolation) + scoped/short-lived credentials + audit. Anthropic reports sandboxing "safely reduces permission prompts by 84%" while preserving safety ([Anthropic: sandboxing](https://www.anthropic.com/engineering/claude-code-sandboxing)); Claude Code on the web restricts git push to the working branch and uses short-lived credentials to "limit the blast radius of any single compromised credential" ([Claude Code security](https://code.claude.com/docs/en/security)). Simon Willison's **"lethal trifecta"** (private data + untrusted content + exfiltration channel) is the canonical threat the human gate must cover — require confirmation for exfiltration-capable actions when state is "tainted" ([Willison: lethal trifecta](https://simonw.substack.com/p/the-lethal-trifecta-for-ai-agents)).
7. **For coding agents, the diff review *is* the residual human-oversight control.** Claude Code's docs are explicit: "You're responsible for reviewing proposed code and commands for safety before approval" ([Claude Code security](https://code.claude.com/docs/en/security)). Tests/conformance checks are the verification backstop ([Willison: agentic engineering patterns](https://simonw.substack.com/p/agentic-engineering-patterns)).

### 1.3.1 The most important best practice: design *against* oversight fatigue

This is the most overlooked finding, and the one most relevant to an observability product, because it is **measurable**.

- **It's real and quantified.** Anthropic: users approve **93%** of manual permission prompts → "approval fatigue, where people stop paying close attention" ([auto mode](https://www.anthropic.com/engineering/claude-code-auto-mode)). When the approval stream becomes constant, *"users stop reading and start clicking,"* and teams then flip on auto-approve, which **"preserves the appearance of oversight while removing the actual decision point"** ([NHI Mgmt Group](https://nhimg.org/articles/human-oversight-fails-first-in-ai-agent-governance/)).
- **More review is not monotonically safer.** Realized safety follows an **inverted-U** against escalation rate: on a 125-action dataset with 50-review capacity, escalating ~72% gave a 22% danger rate vs. **39% at full escalation**; with only 10-review capacity, full escalation gave **69% danger** ([arXiv: Oversight Has a Capacity](https://arxiv.org/html/2606.08919v1), peer-reviewed-style primary research). Same work: reviewers don't even agree on what's "risky" (Fleiss κ=0.52), and fatigue is **adversarially exploitable** via benign-action flooding.
- **It's grounded in classic human-factors science.** The **out-of-the-loop performance problem** (Endsley & Kiris, 1995) — operators lose situation awareness under high automation and can't resume control well, with the decrement *greater under full automation than intermediate levels* ([Endsley & Kiris 1995](https://journals.sagepub.com/doi/10.1518/001872095779064555)); the **vigilance decrement** during passive monitoring ([Gouraud et al. 2017](https://pmc.ncbi.nlm.nih.gov/articles/PMC5633607/)); and **automation bias** amplified for LLMs by output fluency ([Springer review](https://link.springer.com/article/10.1007/s00146-025-02422-7)).
- **Detectable behavioral signals:** approvals getting *faster* while change complexity stays constant; a heuristic that ~10 approvals/session is honestly reviewable while ~100 collapses into rubber-stamping ([AI Pattern Book: approval fatigue](https://aipatternbook.com/approval-fatigue)). The fix is **risk-tiered prompting** so real blast-radius actions still stand out ([developersdigest](https://www.developersdigest.tech/blog/approval-fatigue-agent-security-bug)).
- **Keep the human in the *active* loop, not passive monitoring.** Intermediate automation preserves situation awareness better than full automation (Endsley). "Meaningful oversight" requires authority, context, tools, and real intervention ability — otherwise it's a rubber stamp ([SystemsIntegrity](https://www.systemsintegrity.org/from-human-in-the-loop-to-human-with-agency-why-ai-oversight-fails-when-humans-are-present-but-powerless/)).

### 1.3.2 Adjustable / earned autonomy

Start restrictive, loosen as the agent (and the human's calibrated trust in it) proves out — and tighten again when warranted. Calibrated trust, not blanket trust or distrust, is the goal ([Okamura & Yamada: adaptive trust calibration](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC7034851/)).

## 1.4 What's worth *measuring* about HITL (the core of an observability product)

A HITL-observability tool's job is to surface whether oversight is healthy. The strongest candidate metrics, with sourced targets where they exist:

**Autonomy & trust trend (the headline)**
- **Autonomy mix** — distribution of sessions/turns by permission mode (`plan`/`default`/`acceptEdits`/`bypass`). Anthropic tracks exactly this: auto-approve adoption **20%→40%** with experience; fleet-level "73% of tool calls appear to have a human in the loop in some way" ([measuring agent autonomy](https://www.anthropic.com/research/measuring-agent-autonomy)).
- **Turn duration / session length trend** — Anthropic's p99.9 turn duration grew from <25 min to >45 min in one quarter ([ibid](https://www.anthropic.com/research/measuring-agent-autonomy)) — a proxy for how much unsupervised runway agents get.
- **Trust calibration** — does autonomy rise *while outcomes (merge/revert/CI/friction) stay healthy*? Over-trust and under-trust are both observable as behavioral signals, not just self-report ([trust calibration](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC7034851/)).

**Approval friction & intervention**
- **Approval/denial rate** per session/tool/user/repo. Override rate is a core HITL metric (practitioner heuristics: sustained >50% → rules/model need work; <30% → safe to relax — [Improvado](https://improvado.io/blog/human-in-the-loop-ai), directional only).
- **Intervention / interruption rate** — Anthropic: new users interrupt ~5% of turns, experienced ~9% (interruption *rises* with experience — experienced users delegate more *and* catch more) ([measuring agent autonomy](https://www.anthropic.com/research/measuring-agent-autonomy)).
- **Approvals-per-session** — directly tied to fatigue (~10 reviewable, ~100 rubber-stamp — [AI Pattern Book](https://aipatternbook.com/approval-fatigue)).

**Human latency & fatigue**
- **Time-to-respond** to a `Notification`/`PreToolUse` prompt — the core human-latency metric; approval-gate latency is a "production-viability" concern (a multi-hour queue is "effectively an outage" — [Hendricks AI](https://hendricks.ai/insights/decision-latency-ai-agent-systems-production-viability)).
- **Rubber-stamp / over-trust detector** — auto-accept share rising *while* denial rate → 0 *and* response latency collapses. The single most defensible novel insight; backed by Anthropic's 93% and the capacity literature.

**Coding-agent acceptance / correction**
- **Merge rate** of agent-touched PRs; **AI revert %** (informal ~5% watch threshold); **review rework %**; **prompt→commit success rate** ([Augment Code: autonomous-dev metrics](https://www.augmentcode.com/tools/autonomous-development-metrics-kpis-that-matter-for-ai-assisted-engineering-teams); [Swarmia](https://www.swarmia.com/blog/five-levels-ai-agent-autonomy/)). Agents measurably trail humans on PR acceptance and vary by task type ([arXiv 2602.08915](https://arxiv.org/html/2602.08915v1)).

**Over-permissioning** — tools/sessions under `bypass` that *also* produce errors/reverts/CI failures: autonomy granted where it wasn't warranted ([Sonrai](https://sonraisecurity.com/blog/why-ai-agents-need-least-privilege-too-and-how-to-enforce-it-automatically/); [AWS Well-Architected GenAI lens](https://docs.aws.amazon.com/wellarchitected/latest/generative-ai-lens/gensec05-bp01.html)).

Good HITL observability **frames these as a story about trust and control**, and pairs autonomy with outcomes (honoring DESIGN_DOC §10.6 — cost/automation is "directionally useful and precisely misleading" without an outcome signal beside it).

## 1.5 How peer observability tools implement HITL (competitive landscape)

This directly informs what "good" looks like for *this* product. The LLM-observability field is converging on a pattern:

- **OpenTelemetry GenAI semantic conventions** now stably cover LLM/agent/tool spans (`gen_ai.operation.name` e.g. `execute_tool`/`invoke_agent`, `gen_ai.tool.name`, `gen_ai.tool.call.id`, token usage) — the tool-call provenance primitives HITL telemetry builds on ([OTel GenAI](https://opentelemetry.io/blog/2026/genai-observability/)). A **human-feedback schema** (`gen_ai.task.feedback.source` = `human`/`ground_truth`/`evaluator`, `.rating`, `.value`) is proposed but **not yet ratified** ([semconv issue #2665](https://github.com/open-telemetry/semantic-conventions/issues/2665)) — so "standardized HITL telemetry" does not yet exist; this product is not late.
- **LangSmith** — traces + **annotation queues** (single-run and pairwise) where humans flag/score runs, feeding evaluator calibration; dashboards show feedback scores beside latency/error/cost ([LangSmith observability](https://www.langchain.com/langsmith/observability)).
- **Langfuse** — human feedback as **scores** on traces/observations/sessions (boolean/numeric/categorical), explicit (thumbs/stars) *and* **implicit** (time reading, copying output, **accepting suggestions, retrying**) ([Langfuse user feedback](https://langfuse.com/docs/observability/features/user-feedback)).
- **Datadog LLM/Agent Observability** — thumbs + **"accepted changes"** + free-text feedback joined to spans, plus annotation queues; ingests OTel GenAI conventions natively ([Datadog evaluations](https://docs.datadoghq.com/llm_observability/evaluations/)).
- **Arize Phoenix** (OSS) — **per-span** human annotations/thumbs on individual tool calls and reasoning steps, human labels as ground truth ([Phoenix](https://arize.com/phoenix/)).

**Takeaways for positioning:** (1) the field's HITL primitive is *feedback/annotation attached to traces*, plus *acceptance signals* ("accepted changes," implicit accept/retry); (2) **none of these specialize in coding-agent telemetry correlated to GitHub PRs/teams/cost** — that is this product's differentiated ground; (3) an "annotation queue" over sampled sessions (which this product can already reach via the access-grant + investigator machinery) is a natural, on-architecture feature that maps onto the peer pattern.

## 1.6 Governance & risk (HITL as a required control)

Human oversight is increasingly a *required* control, not a nicety — and for an internal tool at ~200 devs the value is **governance evidence**, not just compliance.

- **EU AI Act, Article 14** requires high-risk systems be designed for effective human oversight "commensurate with the risks, level of autonomy and context of use," and enumerates five capabilities the overseer must have, verbatim: (a) understand capacities/limitations; **(b) "remain aware of the … tendency of automatically relying or over-relying on the output" (automation bias)**; (c) correctly interpret output; (d) decide not to use / disregard / override / reverse; **(e) intervene or interrupt via a "stop button."** Article 14(5) adds a **two-person rule** for biometric ID ([artificialintelligenceact.eu/article/14](https://artificialintelligenceact.eu/article/14/)). High-risk obligations were slated for Aug 2026; a provisional "Digital Omnibus" may push most Annex III duties to Dec 2027 — treat as provisional ([Legal Nodes](https://www.legalnodes.com/article/eu-ai-act-2026-updates-compliance-requirements-and-business-risks)).
- **NIST AI RMF** (GOVERN/MAP/MEASURE/MANAGE) names human oversight across subcategories — notably **MANAGE 2.4**: mechanisms to "supersede, disengage, or deactivate" systems behaving inconsistently with intent ([NIST AI RMF Core](https://airc.nist.gov/airmf-resources/airmf/5-sec-core/)). The **GenAI Profile (NIST AI 600-1, Jul 2024)** adds a "Human-AI Configuration" risk category for calibrating oversight ([NIST](https://www.nist.gov/itl/ai-risk-management-framework)).
- **ISO/IEC 42001** requires defining human involvement proportional to risk and designing systems to support (not replace) human judgment ([ISO](https://www.iso.org/standard/42001)). **OECD AI Principles (2024)** strengthened "human agency and oversight" and expanded the Accountability principle to require lifecycle **traceability** ([OECD](https://www.oecd.org/en/topics/ai-principles.html)).
- **Convergent theme:** EU AI Act, NIST, ISO 42001, and OECD all independently name **automation bias / over-reliance** as the failure oversight must counter — i.e., §1.3.1 is not just good practice, it's the explicit regulatory target.

**The coding-agent–specific control mapping (highly relevant to this product):**
- **Code review with separation of duties is the human-oversight control.** SOC 2 **CC8.1 (change management)** requires documented authorization, testing, and segregation of duties for every production change — applied equally to AI-generated code; the accountable human is "the human who hit accept," and **must not be the author/prompter** ([thebrightbyte: AI coding agents & SOC2](https://thebrightbyte.com/playbook/expertise/ai-coding-agents-soc2); [soc2auditors](https://soc2auditors.org/insights/soc-2-change-management-controls/)).
- **Provenance/attribution** — recommended practice is PR-template AI-assist checkboxes + commit trailers + CODEOWNERS so audit queries find AI code deterministically ([thebrightbyte](https://thebrightbyte.com/playbook/expertise/ai-coding-agents-soc2); [Augment Code SOC2 guide](https://www.augmentcode.com/tools/ai-coding-tools-soc2-compliance-enterprise-security-guide)).
- **Threat framing** — OWASP **LLM06 "Excessive Agency"** (excessive functionality/permissions/autonomy) and the agentic **ASI05 "Unexpected Code Execution"** both call for human approval of high-impact actions ([Aembit: OWASP LLM](https://aembit.io/blog/owasp-top-10-llm-risks-explained/); [Indusface: OWASP Agentic](https://www.indusface.com/learning/owasp-top-10-agentic-ai/)).
- **Accountability lands on the deploying org/operator,** not the model — analyst/scholarly consensus and early enforcement pattern, not settled statute except narrow sector laws (UK AV Act 2024) ([Hung-Yi Chen](https://www.hungyichen.com/en/insights/ai-agent-liability-framework)).

> **This is a sharp, on-architecture opportunity:** the product *already* correlates sessions→PRs and captures `pr_review_decision`/`pr_ci_status`. It is uniquely positioned to be the **provenance + human-oversight-evidence layer for AI-authored code** — answering "which merged code was agent-assisted, who reviewed it, and was the reviewer ≠ the author?" That is exactly what SOC2/EU-AI-Act-style oversight evidence requires, and no peer LLM-observability tool does it.

---

# Part 2 — Assessment of This Project's HITL Capabilities

## 2.1 Framing: an observe-only platform

The product ingests telemetry from agents on developer machines, archives transcripts, correlates to PRs, and exposes dashboards (DESIGN_DOC §4). It is **not** in the request path of any tool call. Two consequences:

- **In-scope HITL role:** *observe, measure, and report on* the human↔agent oversight that already happens — and turn it into insight for devs, leads, and leadership. (It also has genuine *operational* HITL of its own: the access-grant approval workflow and the alert/notification engine.)
- **Out-of-scope by design:** real-time tool-call approval/denial, remotely pausing a live session, pushing decisions back to the agent. The agent owns that loop on the dev machine. Building a competing real-time gate here would duplicate the agent and fight the architecture. *(This reframes several apparent "gaps" — see §2.4.)*

## 2.2 What exists today (verified against the code)

| Capability | Status | Evidence |
|---|---|---|
| **`Notification` event capture** — Claude Code's "needs you" hook is a first-class event type, ingested and renderable | ✅ | [packages/schemas/src/event.ts:24,106](../../packages/schemas/src/event.ts); mapped in [apps/hook/src/lib/payload.ts:43](../../apps/hook/src/lib/payload.ts); installed by every adapter ([claude-code.ts:17](../../apps/hook/src/adapters/claude-code.ts)) |
| **Permission-prompt / denial tracking** — per-session counters and per-event flags | ✅ | `permission_prompt_count`, `permission_deny_count`, `interrupt_count` on sessions (DESIGN_DOC §5.2); `was_denied` / `was_interrupted` on the tool block ([event.ts:54-55](../../packages/schemas/src/event.ts)) |
| **Denials as a first-class effectiveness signal** — friction score weights denial rate at **30%** | ✅ | `denyRate*0.3 + errorRate*0.3 + interruptRate*0.25 + shortAbandoned*0.15` ([packages/schemas/src/effectiveness.ts:45](../../packages/schemas/src/effectiveness.ts)); badge bands Low `<0.2` / Medium `<0.5` / High ([apps/web/src/lib/effectiveness.ts:11](../../apps/web/src/lib/effectiveness.ts)) |
| **Alert rules engine** — scheduled, idempotent, **aggregate-only** evaluation of spend-spike / high-error-rate / unknown-model thresholds | ✅ | 3 seeded rules ([0002_seed_builtin_alert_rules.sql](../../packages/db/sql/migrations/0002_seed_builtin_alert_rules.sql)); thresholds in [packages/schemas/src/alerts.ts](../../packages/schemas/src/alerts.ts); job in `apps/ingest/src/jobs/evaluate-alerts.ts` |
| **Multi-channel notification delivery** — webhook / Slack / email-seam, retried, with delivery logging; payloads aggregate-only (no IDs, no transcript) | ✅ | `apps/ingest/src/lib/notify/*`; admin UI `/admin/alerts` |
| **Time-boxed access grants** — request → org-admin approve → time-boxed/expiring → revoke; a genuine *blocking approval gate* the product owns | ✅ | `AccessGrant` model; `/admin/access-grants`, `/me/grants`; `hasActiveGrant()` in [apps/web/src/lib/roles.ts](../../apps/web/src/lib/roles.ts) (DESIGN_DOC §8.4) |
| **Investigator role** — no standing access; views only under an active, approved, expiring grant | ✅ | `OrgRole.INVESTIGATOR` (DESIGN_DOC §8.1) |
| **Pervasive audit log** — every privileged cross-user view + grant lifecycle step, visible to the *viewed* user | ✅ | `AuditLog` / `AuditAction`; `/me/audit` (DESIGN_DOC §8.3) |
| **Anomaly banners** — render-time anomalies on the org dashboard sharing the alert thresholds | ✅ | `apps/web/src/app/org/dashboard/page.tsx` |
| **PR review correlation** — captures `pr_review_decision` (APPROVED / CHANGES_REQUESTED / REVIEW_REQUIRED) and `pr_ci_status` per session | ⚠️ partial | [packages/schemas/src/session-context.ts](../../packages/schemas/src/session-context.ts); `apps/github-app/src/handlers/pull-request.ts` — captured, not framed as a human-review/provenance surface |

**Read this honestly:** on the *governance* side of HITL (approvals, audit, least-exposure, trust guardrails), the product is genuinely strong — arguably its best-developed dimension, and it maps cleanly onto the NIST/EU-AI-Act controls in §1.6. The access-grant workflow is a textbook blocking-approval gate with expiry and audit (NIST MANAGE 4.1-style appeal/override). The alert engine's aggregate-only discipline is exactly the "oversight without surveillance" posture good HITL governance calls for.

## 2.3 Captured-but-wasted signal (the high-value gaps)

These are the most actionable findings because the cost to capture is near-zero or already paid:

1. **Permission/autonomy `mode` is never actually captured.** The schema has `session_context.mode` (`'normal'|'plan'|'accept_edits'`, DESIGN_DOC §6.3/§10.1), but **every adapter hardcodes `'normal'`** on the hot path: [payload.ts:171](../../apps/hook/src/lib/payload.ts), [opencode.ts:119](../../apps/hook/src/adapters/opencode.ts), [codex.ts:83](../../apps/hook/src/adapters/codex.ts). The flusher enriches *git* context but not mode. **Net effect: the single most important HITL dimension — how much autonomy the human granted — is invisible.** A `plan`-mode session and a `bypassPermissions` run look identical in the data. This is the exact dimension Anthropic uses to chart autonomy trends (§1.4), and everything in the "autonomy mix" / "over-permissioning" / "rubber-stamp" metric families is blocked on it.

2. **`Notification` payloads are ingested but never classified.** Claude Code's notification carries a `message` describing *why* it wants attention. Because `message` isn't in the hook's `KNOWN_KEYS`, it's passed through into the event `metadata` JSONB verbatim ([payload.ts:57-68](../../apps/hook/src/lib/payload.ts)) — **stored, but never parsed into "waiting for permission" vs "waiting for idle input" vs "task complete."** So the platform can count `Notification` events but can't say what fraction are the agent *blocking on a human*.

3. **No "time-to-respond" derivation.** The data to compute how long a human took to answer a prompt exists (timestamp gap between a `Notification`/`PreToolUse` and the next event), but no job or query derives it. This is the core human-latency / oversight-fatigue metric (§1.4).

## 2.4 Conspicuous absences — and which are real

Filtered through the observe-only framing (§2.1), the missing capabilities sort into three buckets:

**Real gaps worth closing (observability):**
- **No "oversight / autonomy" framing anywhere in the UI.** Denials, interrupts, and notifications exist as scattered counters and a friction sub-weight, but nothing presents "how much human oversight is happening / how calibrated is our autonomy." The central product gap.
- **No autonomy-mode analytics** (blocked on §2.3 #1).
- **No notification/response-latency analytics** (blocked on §2.3 #2/#3).
- **No oversight-fatigue / rubber-stamp detection** — the §1.3.1 risk (and the EU AI Act's named target) is unmeasured.
- **No PR-review / provenance surface** — review state is captured but there's no "agent-heavy PRs awaiting human review" view and no "was the reviewer ≠ the author?" provenance evidence (the SOC2/governance angle, §1.6).
- **No human-feedback/annotation capture** — peers (LangSmith/Langfuse/Datadog/Phoenix) all let a human attach a score/annotation to a session/trace; this product has no thumbs/annotation primitive, so it can't capture the "was this session actually good?" ground-truth that calibrates everything else.

**Real gaps in the product's *own* operational HITL (the parts it owns end-to-end):**
- **No central "needs my attention" inbox** — pending access-grant requests live only in `/admin/access-grants`; no consolidated queue, no bulk approve, no requester-visible turnaround/SLA.
- **No alert acknowledge / silence / snooze** — alerts fire idempotently but an admin can't say "seen it, mute 24h." Without this, the alert engine itself is vulnerable to the alert-fatigue failure mode (§1.3.1).
- **No grant-expiry warning** — grants revoke silently at expiry.

**Out-of-scope by design (do *not* build as real-time features):**
- Real-time tool-call approve/deny, remote session-stop/interrupt, pushing feedback to the agent about a denial. These belong to the agent's own loop on the dev machine (§2.1). The platform should *observe* these, not *perform* them. (A deliberately separate control-plane product could revisit this, but it's a different architecture and trust contract.)

---

# Part 3 — Recommendations (prioritized)

Framed by value-to-effort and mapped to the existing architecture and the three audiences (individual dev / team lead / org-leadership, DESIGN_DOC §3). Proposals for discussion, not committed scope.

## Tier 1 — Keystone, low-cost, unblock everything (do these first)

**R1. Actually capture the permission/autonomy mode.**
*Why:* unblocks the entire autonomy dimension (§1.4, §2.3 #1) — the difference between this being a HITL-observability tool and not. It's the metric Anthropic itself leads with.
*How:* each adapter reads the real mode from the hook payload instead of hardcoding `'normal'` (map Claude Code `plan`/`acceptEdits`/`bypassPermissions`/`default`; Codex approval+sandbox flags; OpenCode resolved permission). Keep it a cheap field read on the hot path — no new I/O. Persist per-event; roll `primary_mode` / mode-mix onto the session aggregate. Backfill is impossible, so capturing *now* is the expensive-to-defer part (DESIGN_DOC §10.3 "capture now, surface later").
*Effort:* S.

**R2. Classify `Notification` events.** Parse the notification `message` from `metadata` into an enum (`WAITING_FOR_INPUT`/`NEEDS_PERMISSION`/`TASK_COMPLETE`/`OTHER`) in ingest; store as a derived column or normalized `metadata.notification_kind`. No hook change — the data already arrives. *Effort:* S.

**R3. Derive time-to-respond.** In an existing scheduled job (e.g. alongside `compute-effectiveness`), compute the gap from each blocking `Notification`/`PreToolUse` to the next event; aggregate to session/user. Pure read-side derivation from stored data. *Effort:* S–M.

## Tier 2 — Surface it: the "Oversight & Autonomy" lens

**R4. An oversight/autonomy widget set, reusing the existing dashboard machinery** (date-range selector, period-over-period deltas, visibility-policy gating — all already built, DESIGN_DOC §12.3/§12.4):
- **My Agents (`/me`):** your autonomy mix, denial-rate trend, median response time, interrupts — framed as *your* control posture, not a scorecard (trust-anchor first, DESIGN_DOC §8).
- **Team:** distribution of autonomy modes and approval friction (aggregate, policy-gated — no individual's score leaking, per Phase 7 criteria).
- **Org/leadership:** "how much autonomy do we grant our coding agents, and is it calibrated?" — autonomy mix over time **paired with outcome signals** (merge/revert/CI) per §10.6. Doubles as governance evidence (§1.6).
*Effort:* M. A v0 (denials/interrupts/notifications) ships on today's data; the rich version depends on R1–R3.

**R5. Oversight-fatigue / rubber-stamp detector.** *Why:* directly addresses the #1 HITL failure mode (§1.3.1), the EU AI Act's named target, and is a genuinely novel, defensible insight backed by Anthropic's 93% datapoint and the oversight-capacity literature. *How:* a derived signal flagging users/teams where auto-accept (`acceptEdits`/`bypass`) share is rising *while* denial rate trends to ~0 *and* response latency collapses (and/or approvals-per-session enters the "rubber-stamp" band, ~100+). Surface gently on `/me` ("you've been auto-accepting — here's a session worth a second look") and as an aggregate for leads/org. *Effort:* M. *Depends on:* R1–R3.

**R6. Add HITL/autonomy facets to existing search** (P4-002/P7-006 already support shape/friction/agent-type facets). Add `mode` and `notification_kind` so an investigator can find "all bypass-mode sessions on repo X that had errors." *Effort:* S. *Depends on:* R1, R2.

## Tier 3 — Strengthen the product's own operational HITL

**R7. Alert acknowledge / silence / snooze** on `/admin/alerts` + a new `AuditAction`. Without it the alert engine drifts toward the very alert fatigue it exists to fight (§1.3.1). *Effort:* S–M.

**R8. A consolidated "Needs attention" queue** for the operational flows the product owns end-to-end: pending access-grant requests (with requester-visible expected turnaround), unresolved alerts, persistent delivery failures. Add bulk approve + grant-expiry warning. *Effort:* M.

**R9. New alert rule type: "autonomy / oversight anomaly."** The rule-type enum is already extensible (3 seeded TEXT rules). Add a rule that fires when bypass-mode usage spikes or org-wide denial rate collapses — promoting R5's signal into the existing fire/resolve/notify pipeline (aggregate-only). *Effort:* M. *Depends on:* R1, R5.

## Tier 4 — Differentiated bets (larger, higher ceiling)

**R10. Provenance + human-oversight-evidence for AI-authored code.** *Why:* the strongest differentiated opportunity (§1.6) — no peer LLM-observability tool correlates agent sessions to merged PRs and reviewers. The product already has session→PR links and `pr_review_decision`. *How:* a surface/report answering "which merged code was agent-assisted, who reviewed it, **was the reviewer ≠ the author/prompter**, and did CI pass?" — the exact SOC2 CC8.1 / EU-AI-Act Art.14 oversight evidence. Includes an "agent-heavy PRs awaiting human review" queue (the natural HITL handoff). *Effort:* M–L.

**R11. Human feedback / annotation primitive.** *Why:* matches the universal peer pattern (§1.5) and supplies the ground-truth that calibrates friction/autonomy signals (and honors §10.6 — outcome beside cost). *How:* a lightweight thumbs/rating + note attached to a session (and optionally a transcript message), surfaced on `/me/sessions` and via an investigator "annotation queue" over sampled sessions (reusing the grant/audit machinery). Model after Langfuse scores / Datadog "accepted changes." Align field names loosely with the OTel `gen_ai.task.feedback.*` proposal so it's forward-compatible if that ratifies. *Effort:* M.

**R12. Governance/oversight-posture report.** An exportable report (autonomy mix, approval/denial rates, interruption rate, audit-trail completeness, access-grant history, AI-PR review-coverage from R10) as evidence for EU AI Act Art.14 / NIST RMF / SOC2 expectations (§1.6). Natural fit for the aggregate-viewer/leadership audience. *Effort:* M. *Depends on:* R1, R10.

**Explicitly NOT recommended (architecture mismatch):** real-time tool approval, remote session interrupt, or agent feedback channels in this platform. They belong to the agent's loop, not the observability plane (§2.1, §2.4). Revisit only as a deliberately separate control-plane product.

## Suggested sequencing

```
R1 (capture mode) ─┬─► R4 (autonomy lens) ─► R5 (fatigue detector) ─► R9 (autonomy alert)
R2 (classify notif)┤        │
R3 (response time) ┘        └─► R6 (facets)

R7 (ack/silence)   ─── independent, ships anytime
R8 (attention queue) ─── independent

R10 (PR provenance) ─► R12 (governance report)
R11 (feedback/annotation) ─── independent; feeds R4/R5 calibration
```

Tier 1 (R1–R3) is the unlock: three small, mostly hot-path-or-read-side changes that convert existing-but-wasted signal into the foundation for everything else. Tier 2 rides the dashboard/search machinery the product already has. Tier 4 (R10–R12) is where the product can become *the* AI-coding-oversight system of record — work no general LLM-observability tool is positioned to do.

---

## Appendix — Sources

> Confidence varies: vendor/primary docs and peer-reviewed papers are load-bearing; practitioner blogs and numeric heuristics (intervention-rate bands, approvals-per-session thresholds, review-speedup %) are directional and flagged inline. A few statutory/standards pages (EU AI Act Art.14, NIST, ISO 42001) and some primaries (OpenAI agent guide, a couple of arXiv/PMC items) were corroborated via search where direct fetch was blocked (403). Vendor blogs are practitioner signal, not standards.

**HITL concepts, spectrum, autonomy levels**
- [Wikipedia — Human-in-the-loop](https://en.wikipedia.org/wiki/Human-in-the-loop) · [War on the Rocks — myths dispelled](https://warontherocks.com/autonomous-weapon-systems-no-human-in-the-loop-required-and-other-myths-dispelled/) · [TekLeaders](https://tekleaders.com/human-in-the-loop-vs-human-on-the-loop-agentic-ai/) · [n8n](https://blog.n8n.io/human-in-the-loop-vs-human-on-the-loop/)
- [Google Cloud — HITL (MLOps)](https://cloud.google.com/discover/human-in-the-loop) · [Falconer — levels of agent autonomy](https://seanfalconer.medium.com/the-practical-guide-to-the-levels-of-ai-agent-autonomy-ac5115d3af26) · [Data Agents L0–L5](https://techlife.blog/posts/data-agents/) · [Vellum](https://www.vellum.ai/blog/levels-of-agentic-behavior) · [Swarmia — 5 levels](https://www.swarmia.com/blog/five-levels-ai-agent-autonomy/)

**HITL in coding agents / approval patterns**
- Claude Code: [settings](https://code.claude.com/docs/en/settings) · [hooks](https://code.claude.com/docs/en/hooks) · [permission modes](https://code.claude.com/docs/en/permission-modes) · [Agent SDK permissions](https://platform.claude.com/docs/en/agent-sdk/permissions) · [security](https://code.claude.com/docs/en/security)
- [Cursor — modes](https://cursor.com/docs/agent/modes) · [terminal](https://cursor.com/docs/agent/terminal) · [VS Code Copilot agents](https://code.visualstudio.com/docs/copilot/agents/overview) · [Copilot cloud agent](https://docs.github.com/copilot/concepts/agents/coding-agent/about-coding-agent)
- [Codex CLI reference](https://developers.openai.com/codex/cli/reference) · [Codex approvals & security](https://developers.openai.com/codex/agent-approvals-security) · [OpenCode permissions](https://opencode.ai/docs/permissions/) · [Aider git](https://aider.chat/docs/git.html) · [Aider options](https://aider.chat/docs/config/options.html)
- [Microsoft Agent Framework — tool approval](https://learn.microsoft.com/en-us/agent-framework/agents/tools/tool-approval) · [LangChain HITL middleware](https://docs.langchain.com/oss/python/langchain/human-in-the-loop) · [Permit.io](https://www.permit.io/blog/human-in-the-loop-for-ai-agents-best-practices-frameworks-use-cases-and-demo) · [StackAI](https://www.stackai.com/insights/human-in-the-loop-ai-agents-how-to-design-approval-workflows-for-safe-and-scalable-automation) · [TeamCopilot](https://teamcopilot.ai/blog/human-in-the-loop-ai-agents-approvals-permissions-audit-trails) · [Galileo](https://galileo.ai/blog/human-in-the-loop-agent-oversight) · [OpenAI — practical guide to building agents](https://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents/)

**Anthropic first-party data (Claude Code)**
- [Measuring agent autonomy](https://www.anthropic.com/research/measuring-agent-autonomy) · [Claude Code auto mode (93% approval, classifier tiers, error rates)](https://www.anthropic.com/engineering/claude-code-auto-mode) · [Claude Code sandboxing (84% prompt reduction)](https://www.anthropic.com/engineering/claude-code-sandboxing)

**Oversight fatigue / automation bias / human factors**
- [arXiv — Oversight Has a Capacity (inverted-U, κ=0.52, adversarial fatigue)](https://arxiv.org/html/2606.08919v1) · [Endsley & Kiris 1995 — out-of-the-loop](https://journals.sagepub.com/doi/10.1518/001872095779064555) · [Gouraud et al. 2017 — vigilance/OOTL review](https://pmc.ncbi.nlm.nih.gov/articles/PMC5633607/) · [Okamura & Yamada — adaptive trust calibration](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC7034851/) · [Springer — automation bias review](https://link.springer.com/article/10.1007/s00146-025-02422-7)
- [AI Pattern Book — approval fatigue](https://aipatternbook.com/approval-fatigue) · [developersdigest — approval fatigue](https://www.developersdigest.tech/blog/approval-fatigue-agent-security-bug) · [NHI Mgmt Group — oversight fails first](https://nhimg.org/articles/human-oversight-fails-first-in-ai-agent-governance/) · [SystemsIntegrity — human with agency](https://www.systemsintegrity.org/from-human-in-the-loop-to-human-with-agency-why-ai-oversight-fails-when-humans-are-present-but-powerless/) · [UXmatters](https://www.uxmatters.com/mt/archives/2025/12/ux-research-insights-balancing-ai-automation-and-human-oversight-in-it-operations.php)

**HITL metrics & observability landscape**
- [OTel GenAI observability](https://opentelemetry.io/blog/2026/genai-observability/) · [OTel feedback schema proposal #2665](https://github.com/open-telemetry/semantic-conventions/issues/2665) · [LangSmith observability](https://www.langchain.com/langsmith/observability) · [Langfuse user feedback](https://langfuse.com/docs/observability/features/user-feedback) · [Datadog LLM evaluations](https://docs.datadoghq.com/llm_observability/evaluations/) · [Arize Phoenix](https://arize.com/phoenix/)
- [Augment Code — autonomous-dev metrics](https://www.augmentcode.com/tools/autonomous-development-metrics-kpis-that-matter-for-ai-assisted-engineering-teams) · [arXiv 2602.08915 — PR acceptance by agent/task](https://arxiv.org/html/2602.08915v1) · [Improvado — HITL metrics](https://improvado.io/blog/human-in-the-loop-ai) · [Hendricks AI — decision latency](https://hendricks.ai/insights/decision-latency-ai-agent-systems-production-viability)

**Governance, standards, security**
- [EU AI Act Article 14](https://artificialintelligenceact.eu/article/14/) · [Legal Nodes — 2026 timeline/Omnibus](https://www.legalnodes.com/article/eu-ai-act-2026-updates-compliance-requirements-and-business-risks) · [NIST AI RMF Core](https://airc.nist.gov/airmf-resources/airmf/5-sec-core/) · [NIST AI RMF (GenAI Profile)](https://www.nist.gov/itl/ai-risk-management-framework) · [ISO/IEC 42001](https://www.iso.org/standard/42001) · [OECD AI Principles](https://www.oecd.org/en/topics/ai-principles.html)
- [SOC2 CC8.1 + AI code (thebrightbyte)](https://thebrightbyte.com/playbook/expertise/ai-coding-agents-soc2) · [soc2auditors — change management](https://soc2auditors.org/insights/soc-2-change-management-controls/) · [Augment Code — SOC2 guide](https://www.augmentcode.com/tools/ai-coding-tools-soc2-compliance-enterprise-security-guide) · [OWASP LLM (Aembit)](https://aembit.io/blog/owasp-top-10-llm-risks-explained/) · [OWASP Agentic (Indusface)](https://www.indusface.com/learning/owasp-top-10-agentic-ai/) · [Willison — lethal trifecta](https://simonw.substack.com/p/the-lethal-trifecta-for-ai-agents) · [Willison — agentic engineering patterns](https://simonw.substack.com/p/agentic-engineering-patterns) · [AWS Well-Architected — GenAI security](https://docs.aws.amazon.com/wellarchitected/latest/generative-ai-lens/gensec05-bp01.html) · [Sonrai — least privilege for agents](https://sonraisecurity.com/blog/why-ai-agents-need-least-privilege-too-and-how-to-enforce-it-automatically/) · [Hung-Yi Chen — agent liability](https://www.hungyichen.com/en/insights/ai-agent-liability-framework)
