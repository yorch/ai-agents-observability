# Agent Adapter Expansion — Codex hooks, Gemini CLI, Copilot CLI, Pi, OMP

**Date:** 2026-08-13
**Scope:** What it takes to add the next wave of coding agents to the `HookAdapter`
seam (`apps/hook/src/adapters/`). Surveys the extension points, session storage, and
usage/cost surfaces of eight agents against the seam's actual requirements.
**Status:** Research + recommendation. Decomposed into
[`tasks/P12-roadmap.md`](../../tasks/P12-roadmap.md). Nothing here is implemented yet.

> **Sourcing note.** Every claim about an agent's hook events, payload fields, or
> storage layout below was read from that project's **primary documentation** (linked
> per section). Claims that came only from a search summary or a third-party blog are
> marked *(unverified)* and should be re-checked before anyone builds against them.

---

## 0. TL;DR

Three findings, in order of how much they change the plan.

1. **The ecosystem converged on Claude Code's hook shape.** Between late 2025 and
   mid-2026, Codex CLI, GitHub Copilot CLI, and Gemini CLI all shipped
   command-hook systems that feed a JSON payload on **stdin** with the same base
   fields Claude Code uses — `session_id`, `transcript_path`, `cwd`,
   `hook_event_name` — and per-tool fields named `tool_name` / `tool_input` /
   `tool_response`. Copilot even documents PascalCase aliases (`PreToolUse`,
   `SessionStart`) alongside its native camelCase names. This was not true when
   P8-003 designed the seam against Claude Code + opencode.

   **Consequence:** the next four adapters are not four bespoke integrations. They
   are one shared "Claude-shaped stdin hook" base plus a per-agent event-name map
   and install snippet. Codex's current adapter — 401 lines of rollout-file
   parsing with a byte cursor — can shrink to roughly the size of `claude-code.ts`.

2. **Pi and OMP are the best-shaped agents we have looked at, better than opencode.**
   Both store one session as a **single JSONL file** with per-message token usage
   *and cost*, which is exactly what the shipper and the `llm` block want. Pi's
   session IDs are already UUIDs. Neither needs the multi-event `mapBatch` path;
   neither hits the directory-storage problem that left opencode without transcript
   upload.

3. **There is a live bug the expansion forces us to fix first.** `EventSchema`
   requires `session_id` to be a **UUID** (`packages/schemas/src/event.ts:85`), and
   `apps/ingest/src/routes/events.ts:71` `safeParse`s every event individually and
   drops the invalid ones. But real opencode session IDs are **`ses_`-prefixed, not
   UUIDs**, and `opencode.ts` passes `raw.sessionID` straight through. The adapter's
   unit test only ever feeds it a UUID-shaped string, so the suite is green while
   real opencode traffic would be silently discarded at ingest. Codex's hook
   `session_id`, Copilot's `sessionId`, and OMP's 16-char hex IDs are all at risk of
   the same class of failure. The seam needs one shared normalization step
   (`packages/`-side `uuidv5` already exists at `apps/hook/src/lib/uuid5.ts`) before
   any new adapter lands.

---

## 1. What the seam actually requires from an agent

From `apps/hook/src/adapters/index.ts` and the invariants in
[`apps/hook/AGENTS.md`](../../apps/hook/AGENTS.md), an agent is "adaptable" if it
offers:

| Requirement | Why | Fallback if absent |
|---|---|---|
| An extension point that can **run a command** at lifecycle boundaries | `hook <kind>` is a subprocess; the hot path is stdin → SQLite → exit 0 | An in-process plugin that shells out (opencode, Pi, OMP) |
| A **session identifier** stable across the session | `session_id` keys every aggregate | Derive from `transcript_path` via `uuidv5` |
| A **cwd** | `session_context.cwd` drives repo/project correlation | `process.cwd()` of the hook process |
| **Tool name + input/output** at pre/post boundaries | `tool` block; `<agent>:<tool>` disambiguation (P8-001) | Tool events simply absent — session/turn events still land |
| **Token usage + model** somewhere | `llm` block; per-agent price tables (P8-002) | Cost is `$0` for that agent — degrades quietly, which is worse than loudly |
| A **single-file transcript** | `shipper.ts` reads one file | `transcriptTarget()` returns null (opencode's escape hatch) |

Nothing below requires widening `packages/schemas`. That is the seam working: the
one interface change since P8-003 is the optional `mapBatch`, and none of the five
agents surveyed here needs it.

---

## 2. Per-agent findings

### 2.1 OpenAI Codex CLI — *we should rewrite our existing adapter*

Sources: [Codex hooks reference](https://learn.chatgpt.com/docs/hooks) (canonical;
`developers.openai.com/codex/hooks` 308-redirects here),
[Advanced configuration](https://developers.openai.com/codex/config-advanced).

Codex gained a **real lifecycle hook system** — first shipped in v0.114 *(version and
date unverified; the feature flag and event list are from the primary doc)*. It is
experimental: gated behind `[features] hooks = true` in `config.toml` (the older
`codex_hooks` key is a deprecated alias), and not available on Windows.

Events: `SessionStart`, `SessionEnd`, `SubagentStart`, `SubagentStop`, `PreToolUse`,
`PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `UserPromptSubmit`,
`Stop`. Config lives in `hooks.json` **or** inline `[hooks]` tables in `config.toml`
(both present in one layer → merged, with a startup warning).

Every command hook receives on stdin: `session_id`, `transcript_path`, `cwd`,
`hook_event_name`, `model`, `permission_mode` (turn-scoped), plus a Codex-specific
`turn_id`. `PreToolUse`/`PostToolUse` add `tool_name`, `tool_use_id`, `tool_input`,
and `tool_response`.

**Why this matters more than a new adapter.** Our P8-007 adapter exists because
`notify` was the *only* stable extension point: turn-granular, no tools, no tokens —
so we tail `~/.codex/sessions/**/rollout-*.jsonl` with a per-session byte cursor and
expand one notify into N events via `mapBatch`. Native hooks make almost all of that
machinery unnecessary: per-tool events arrive directly, `transcript_path` is handed
to us, and the event names are already ours. The rollout reader stays useful for one
thing only — **token usage**, which the hook payload does not carry (it carries
`model`, not usage). So the upgrade is: hooks for lifecycle + tools, rollout read
narrowed to usage-on-`Stop`, `notify` retained as a fallback for users who have not
enabled the experimental flag.

### 2.2 Gemini CLI — *new adapter, cheap*

Sources: [`docs/hooks/reference.md`](https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md),
[Observability with OpenTelemetry](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/telemetry.md).

Hooks are configured in `settings.json` under a `hooks` object, keyed by event, each
entry an array of `{ matcher?, sequential?, hooks: [{ type: "command", command,
timeout? }] }`. Extensions can also bundle `hooks/hooks.json` *(extension-bundled
hooks: from the Google Developers blog + PR #14460, unverified against shipped docs)*.

Event names are Gemini's own, and this is the only real translation work:

| Gemini | ours |
|---|---|
| `SessionStart` / `SessionEnd` | `SessionStart` / `SessionEnd` |
| `BeforeTool` / `AfterTool` | `PreToolUse` / `PostToolUse` |
| `BeforeAgent` / `AfterAgent` | `UserPromptSubmit` / `Stop` |
| `PreCompress` | `PreCompact` |
| `Notification` | `Notification` |
| `BeforeModel` / `AfterModel` / `BeforeToolSelection` | *(no canonical equivalent — drop)* |

The base stdin payload is Claude-shaped: `session_id`, `transcript_path`, `cwd`,
`hook_event_name`, `timestamp`. `BeforeTool`/`AfterTool` carry `tool_name`,
`tool_input`, `tool_response` (with `llmContent` / `returnDisplay` / `error`), plus
optional `mcp_context` — which maps onto our `tool.mcp_server` / `tool.mcp_tool`
fields that opencode and codex both leave null.

**Usage:** `AfterModel` carries `llm_response`, which is the natural place to read
tokens; if that proves unreliable, Gemini CLI has first-class **OTLP export**
including token metrics, and `transcript_path` gives a per-session file to fall back on.

### 2.3 GitHub Copilot CLI — *new adapter, cheap, with one wrinkle*

Source: [GitHub Copilot hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference).

Events (camelCase native, PascalCase aliases documented): `sessionStart`,
`sessionEnd`, `userPromptSubmitted`, `userPromptTransformed`, `preToolUse`,
`postToolUse`, `postToolUseFailure`, `preCompact`, `permissionRequest`, `agentStop`,
`subagentStart`, `subagentStop`, `errorOccurred`, `notification`.

Config is a versioned JSON document — `{ version: 1, disableAllHooks, hooks: { event:
[{ type: "command" | "http" | "prompt", matcher? }] } }` — discovered from a layered
set of locations (`~/.copilot/hooks/`, `.github/hooks/*.json`, `~/.copilot/settings.json`,
policy dirs, plugins). Command hooks take `bash` / `powershell` / cross-platform
`command`, plus `cwd`, `env`, `timeoutSec` (default 30s).

Base payload fields are `sessionId`, `timestamp`, `cwd` — **camelCase**, unlike
everyone else — with `toolName`, `toolArgs`, `toolResult` per event. The PascalCase
event aliases apparently come with ISO-8601 timestamps rather than numeric ones, so
the adapter should read both spellings of every field rather than picking one.

The wrinkle: `postToolUseFailure` and `errorOccurred` have no canonical equivalent.
Per the seam's existing rule ("we never synthesize a non-schema event_type"), map
`postToolUseFailure` → `PostToolUse` with `tool.exit_status` set, and drop
`errorOccurred` rather than inventing a type.

Copilot CLI also has its own OpenTelemetry integration *(unverified)* — relevant to
§4 below, not to the adapter.

### 2.4 Pi — *new adapter, the best-shaped agent surveyed*

Sources: [`packages/coding-agent/docs/extensions.md`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md),
[`session-format.md`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md),
[`sessions.md`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sessions.md).

Pi (`@earendil-works/pi-coding-agent`, formerly `@mariozechner/pi-coding-agent`) has
no stdin command hooks. It has **TypeScript extensions**: a module exporting
`export default function (pi: ExtensionAPI) { … }`, auto-loaded from
`~/.pi/agent/extensions/*.ts` or `.pi/extensions/*.ts`, subscribing via
`pi.on(eventName, handler)`. This is the opencode plugin pattern — a thin extension
that spawns `<bin> hook <kind> --agent pi` and pipes JSON — and it needs no new
seam capability.

The event set is unusually rich, and maps cleanly:

| Pi | ours |
|---|---|
| `session_start` | `SessionStart` |
| `input` / `before_agent_start` | `UserPromptSubmit` |
| `tool_call` (can block) | `PreToolUse` |
| `tool_result` (can modify) | `PostToolUse` |
| `turn_end` / `agent_settled` | `Stop` |
| `session_before_compact` / `session_compact` | `PreCompact` |
| `session_shutdown` | `SessionEnd` |

(Also available and deliberately unused: `context`, `model_select`,
`before_provider_request`, `after_provider_response`, `user_bash`,
`project_trust`, `resources_discover`, `message_*`, `tool_execution_*`.)

Storage is the good part: `~/.pi/agent/sessions/--<path>--/<timestamp>_<uuid>.jsonl`
— **one file per session**, append-only, entries carrying `id` / `parentId` /
`timestamp` and a `type` from a closed set (`session`, `message`, `model_change`,
`compaction`, `branch_summary`, `custom`, `label`, …). **Session IDs are UUIDs.**
Token usage — input, output, cache read/write, *and a cost breakdown* — is recorded
per assistant message.

So Pi gets: real tool events, a `transcriptTarget` that works on day one (unlike
opencode), a native UUID session ID (unlike everyone else), and an `llm` block with
genuine usage. Note the branching model: entries form a tree via `parentId`, so a
transcript parser that assumes linear append will see abandoned branches. That is a
parser concern, not an adapter one — the shipper ships bytes.

There is also a `@earendil-works/pi-telemetry` package ("vendor-neutral telemetry
contracts, reference adapter, conformance tests"), but it is an OpenTelemetry-style
**span** contract for instrumenting pi's own internals, not a stream of agent
lifecycle events. It is the wrong seam for us; extensions are the right one.

### 2.5 OMP (oh-my-pi) — *new adapter, two possible routes*

Sources: [`docs/hooks.md`](https://github.com/can1357/oh-my-pi/blob/main/docs/hooks.md),
[`docs/session.md`](https://github.com/can1357/oh-my-pi/blob/main/docs/session.md),
[`ZeR020/omp-hooks`](https://github.com/ZeR020/omp-hooks).

OMP is a fork of Pi that went the opposite direction — subagents, plan mode, LSP/DAP,
a Rust core with a TypeScript extension layer. Its native hooks are, like Pi's,
**ES modules receiving a `HookAPI` object** — *not* stdin JSON. Events:
`session_start`, `session_before_compact`, `session_compact`, `session_shutdown`,
`before_agent_start`, `agent_start`, `agent_end`, `turn_start`, `turn_end`,
`auto_compaction_start/end`, `context`, `tool_call`, `tool_result`, and others.

Storage: `~/.omp/agent/sessions/<scope>-<project>-<sha256(cwd)>/<timestamp>_<sessionId>.jsonl`
— again **single-file JSONL**, with `usage` (input/output tokens, cache read/write, cost
breakdown) on each message entry, blobs externalized to `~/.omp/agent/blobs/`, and a
fixed 256-byte title slot at the head of the file that a naive JSONL reader must skip.
**Session IDs are 16-char hex** — not UUIDs.

> Two documentation domains disagree on the config root: the repo docs say `~/.omp/`,
> while `omp.sh/docs` and some third-party writeups say `~/.oh-omp/`. `omp.sh/docs`
> returns 403 to our fetcher, so this is unresolved. The adapter should probe both.

Two routes, and I recommend the first:

- **Native extension** (like Pi/opencode): a TS hook module that shells out. Full
  event coverage, one more small integration to maintain, no third-party dependency.
- **Via `omp-hooks`**: a community plugin that makes OMP execute *Claude Code-style*
  `settings.json` command-hook arrays (`~/.omp/agent/settings.json`), covering
  `SessionStart`, `SessionEnd`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`,
  `UserPromptSubmit`, `Stop`, `PreCompact`, `PostCompact`. Zero adapter code beyond
  an event-name map — but it makes our install path depend on a third-party package
  we do not control.

Ship the native extension; document `omp-hooks` as a supported alternative for users
who already run it.

### 2.6 Cursor CLI — *defer, with a reason*

Source: [Cursor hooks](https://cursor.com/docs/hooks).

Cursor has had hooks since 1.7 (Oct 2025): `.cursor/hooks.json`, stdin JSON, stdout
JSON, exit-code blocking. Events include `beforeShellExecution`,
`afterShellExecution`, `beforeMCPExecution`, `afterMCPExecution`, `beforeReadFile`,
`afterFileEdit`, `beforeSubmitPrompt`, `subagentStart`/`subagentStop`.

The blocker is coverage, not shape: **`cursor-agent` (the CLI) reportedly emits only
`beforeShellExecution` / `afterShellExecution`**, with the rest omitted *(source: a
Cursor community forum report, unverified against Cursor docs — worth re-testing
before deciding)*. Nothing here maps to session lifecycle, so sessions would have no
start, no stop, no usage, and no cost — an agent that shows up in `/admin/adapters`
as permanently "inactive"-adjacent and prices at `$0`. Also note Cursor's event names
are its own idiom (`afterFileEdit`, not `PostToolUse`), so it does *not* ride the
Claude-shaped base for free.

Recommendation: keep `CURSOR` in the enum (it is already there), do not build the
adapter this phase, re-test coverage when Cursor next ships CLI hook parity.

### 2.7 Others, briefly

- **Amp (Sourcegraph, `@ampcode/cli`)** — threads sync to ampcode.com; the CLI
  exposes `AMP_API_KEY` / `AMP_LOG_LEVEL` / `AMP_SETTINGS_FILE`. We found no hook
  documentation. Needs a dedicated pass before it can be scoped; not in this phase.
- **Aider** — no lifecycle hook system; history lands in `.aider.chat.history.md` /
  `.aider.input.history` in the repo. Would be a *file-tailing* adapter, not a hook
  adapter — a different shape from everything above, and the only one that would
  genuinely stress the seam. Enum value already exists; leave unimplemented.
- **Windsurf** — enum value exists from P5-006; no research done here.

---

## 3. The convergence, and what to build because of it

Line up the four stdin-hook agents:

| | Claude Code | Codex | Gemini CLI | Copilot CLI |
|---|---|---|---|---|
| transport | stdin JSON | stdin JSON | stdin JSON | stdin JSON (+ http, prompt) |
| session id | `session_id` | `session_id` | `session_id` | `sessionId` |
| cwd | `cwd` | `cwd` | `cwd` | `cwd` |
| event name field | `hook_event_name` | `hook_event_name` | `hook_event_name` | *(per-config)* |
| transcript | `transcript_path` | `transcript_path` | `transcript_path` | — |
| tool fields | `tool_name`/`tool_input`/`tool_response` | same | same | `toolName`/`toolArgs`/`toolResult` |
| event names | ours | **ours** | own (`BeforeTool`…) | own + PascalCase aliases |
| blocking | exit 2 | exit 2 | exit code | exit 2, fail-closed on `preToolUse` |

That is one adapter with three configuration tables, not four adapters. The proposal
is a **`createStdinHookAdapter({ agentType, eventMap, fieldAliases, install })`**
factory in `apps/hook/src/adapters/`, with `claude-code.ts` refactored to be its first
caller (proving the factory preserves today's behavior byte-for-byte), then
codex-hooks, gemini, and copilot as three small config objects. Pi and OMP stay
hand-written — they are plugin-shaped, like opencode — but share the same
session-ID normalization and `llm`-block helpers.

Expected shape of the diff, very roughly: one new ~150-line factory, `claude-code.ts`
shrinking, `codex.ts` losing most of its rollout machinery, and three new files of
50–80 lines each. Compare that against ~400 lines per bespoke adapter and it is
worth doing *before* the new agents, not after.

## 4. The road not taken: an OTLP receiver

A tempting alternative to N adapters: add an **OTLP endpoint to `apps/ingest`** and
let agents that already speak OpenTelemetry push to it. Claude Code, Gemini CLI, and
Copilot CLI all emit OTel; third-party bridges like `o11y-dev/opentelemetry-hooks`
convert hook events into spans for Cursor/Copilot/Gemini/Claude/Codex *(unverified)*.

Rejected for this phase, on three grounds:

1. **It is a second ingestion path, not a shortcut.** Redaction, the local queue,
   offline durability, git/PR correlation, and the transcript shipper all live in the
   hook binary. An OTLP push from the agent bypasses every one of them — we would be
   re-implementing the correlation spine on the server side.
2. **The data is metrics/span-shaped, not session-shaped.** Our schema is built
   around a session's event stream and its transcript. Reconstructing sessions from
   spans is a lossy inverse of what we already do losslessly.
3. **It doesn't reduce the per-agent work much.** Each agent's OTel attribute
   naming still differs; we'd trade an event-name map for an attribute map.

Worth revisiting if the OTel GenAI semantic conventions stabilize around agent
sessions, or for **read-only** deployments where installing our binary is not
possible. Not a substitute for the adapter seam.

## 5. Risks and open questions

- **Codex hooks are experimental** (`[features] hooks = true`, no Windows). Shipping
  an adapter that depends on an off-by-default flag needs the `notify` path kept as a
  fallback and the install command to detect which is available.
- **OMP's config root is unresolved** (`~/.omp/` vs `~/.oh-omp/`); `omp.sh/docs`
  blocks our fetcher. Probe both at install time.
- **The 256-byte title slot** at the head of OMP session files will break a naive
  JSONL reader — the transcript parser needs to skip it.
- **Pi sessions are trees, not lists.** Branch navigation means a transcript can
  contain abandoned branches; anything that counts messages must respect `parentId`.
- **`agent_version` for new agents.** `client.claude_code_version` is a legacy field
  name carrying the agent's version (the DB already has `agent_version` superseding
  `claude_code_version`). Five new agents make the wire-level name harder to justify —
  worth a rename pass, but out of scope here.
- **Price tables.** P8-002's design registers an empty table per agent so unknown
  models bill `$0` *via the table* rather than the unknown-agent fallback. Five new
  agents = five new (initially empty) tables. Pi and OMP record cost themselves, so
  for those two we could ingest agent-reported cost — but that crosses P8-006's
  reconciliation design and should be decided there, not smuggled in per-adapter.

## 6. Recommendation

Do it in this order — the first two are prerequisites, not niceties:

1. **Widen the agent registry** (`PI`, `OMP`, `GEMINI_CLI`) and make
   `/admin/adapters` read from a registry instead of its hard-coded
   `ADAPTER_AGENTS` triple.
2. **Normalize session IDs in the seam** — fixes the opencode drop described in §0.3
   and immunizes every adapter that follows.
3. **Extract the stdin-hook factory** from `claude-code.ts`.
4. **Codex → native lifecycle hooks** (biggest quality win per line changed;
   validates the factory against an agent we already ship).
5. **Gemini CLI**, **Copilot CLI** (factory config objects).
6. **Pi**, then **OMP** (plugin-shaped, both unlock transcript upload immediately).
7. **opencode transcript export** — with Pi and OMP proving the single-file path,
   opencode's directory-storage gap is the last transcript hole.

Cursor, Amp, Aider, Windsurf stay out of this phase, each for a stated reason (§2.6,
§2.7).

Task decomposition: [`tasks/P12-roadmap.md`](../../tasks/P12-roadmap.md).

---

## Sources

Primary documentation:

- [Codex hooks](https://learn.chatgpt.com/docs/hooks) · [Codex advanced configuration](https://developers.openai.com/codex/config-advanced)
- [Gemini CLI hooks reference](https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md) · [Gemini CLI telemetry](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/telemetry.md)
- [GitHub Copilot hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference)
- [Pi extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md) · [Pi session format](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md) · [Pi sessions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sessions.md) · [pi repo](https://github.com/earendil-works/pi)
- [OMP hooks](https://github.com/can1357/oh-my-pi/blob/main/docs/hooks.md) · [OMP session format](https://github.com/can1357/oh-my-pi/blob/main/docs/session.md) · [omp-hooks (Claude-compat bridge)](https://github.com/ZeR020/omp-hooks)
- [Cursor hooks](https://cursor.com/docs/hooks)

Secondary / unverified (marked inline where used):

- [Cursor 1.7 adds hooks (InfoQ)](https://www.infoq.com/news/2025/10/cursor-hooks/) · [Cursor CLI hook coverage report (forum)](https://forum.cursor.com/t/cursor-cli-doesnt-send-all-events-defined-in-hooks/148316)
- [Tailor Gemini CLI to your workflow with hooks (Google Developers Blog)](https://developers.googleblog.com/tailor-gemini-cli-to-your-workflow-with-hooks/) · [Extension hooks PR #14460](https://github.com/google-gemini/gemini-cli/pull/14460)
- [opentelemetry-hooks](https://github.com/o11y-dev/opentelemetry-hooks)
- [opencode session storage (DeepWiki)](https://deepwiki.com/anomalyco/opencode/3.1-session-management)
- [Amp CLI guide](https://github.com/sourcegraph/amp-examples-and-guides/blob/main/guides/cli/README.md)
