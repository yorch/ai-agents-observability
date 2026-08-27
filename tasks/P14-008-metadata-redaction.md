---
id: P14-008
title: Stop passing model and user content through to events.metadata
phase: 14
workstream: A
status: done
owner: claude
depends_on: []
blocks: []
estimate: M
---

## Goal

`events.metadata` holds provenance and nothing else, enforced rather than assumed —
and the enforcement is structural, so the *next* content-bearing field a vendor adds
is refused without anyone having to notice it.

## The defect

`DESIGN_DOC.md` §9.3 says raw tool inputs/outputs and raw prompts never reach the
events table. `packages/redaction` runs on the transcript path only
(`apps/ingest/src/lib/transcript-pipeline.ts`,
`apps/hook/src/lib/transcript-stream.ts`); nothing redacts `events.metadata`, and
`apps/ingest/src/lib/insert-events.ts` wrote the client's object straight through to
JSONB. So metadata's only safety property was what the producer chose to put in it.

Every adapter's metadata builder was a **denylist**: keys the adapter captured
structurally were excluded, and everything else passed through **verbatim** so an
unmodelled field would be preserved rather than lost. Sound for `turn_id` or `model`.
Not sound the moment a vendor ships a field holding prose — and two had:

- **Claude Code** `Stop` / `SubagentStop` carry `last_assistant_message`. From the
  installed 2.1.247 binary's own hook schema, verbatim:
  `last_assistant_message: e().optional().describe("Text content of the last
  assistant message before stopping. Avoids the need to read and parse the
  transcript file.")`. It is absent from `CLAUDE_KNOWN_KEYS`, so **assistant prose
  was written to Postgres unredacted on every Stop and SubagentStop**.
- **Copilot CLI** `userPromptSubmitted` carries `prompt`, and that adapter declared
  no `knownKeys` at all — so **the user's whole prompt** was passing through, by the
  same mechanism, unnoticed.

Flagged as out of scope in
[`P14-006`](./P14-006-live-turn-linkage.md#out-of-scope) and picked up here.

## The per-adapter audit

Seven adapters. Evidence for each is the vendor's current documentation or source
(not memory), plus the shipped Claude Code binary. Every content-bearing field found
is now refused.

| Adapter | Passthrough? | Content-bearing fields that could reach `metadata` | Evidence |
|---|---|---|---|
| **claude-code** | yes | `last_assistant_message` (Stop, SubagentStop), `custom_instructions` (PreCompact), `session_title` (SessionStart), `message` + `title` (Notification), `background_tasks[].description`, `session_crons[]` | Zod hook-input schemas read out of `~/.local/share/claude/versions/2.1.247`; `stop_hook_active` + `permission_mode` present in the same region confirm the right file. Also `code.claude.com/docs/en/hooks` |
| **codex** | yes (native hooks) | `last_assistant_message` (Stop, SubagentStop) — `prompt` was already excluded | `learn.chatgpt.com/docs/hooks` |
| **codex** (`notify`) | **no** | payload *does* carry `input-messages` and `last-assistant-message` (kebab-case), but `mapPayload`/`assemble` build `metadata: {}` literally | `codex-rs/hooks/src/legacy_notify.rs`, `#[serde(rename_all = "kebab-case")]` with a unit test pinning the literal JSON |
| **gemini-cli** | yes | `prompt` (BeforeAgent), `prompt` + `prompt_response` (AfterAgent), `message` (Notification), `llm_request` / `llm_response` (Before/AfterModel — the **entire conversation**, not one turn) | `github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md` |
| **copilot** | yes | `prompt` (userPromptSubmitted), `initialPrompt`/`initial_prompt` (sessionStart), `response` ⇄ `last_assistant_message` (subagentStop — **a rename, not a recasing**), `error` (postToolUseFailure), `customInstructions`/`custom_instructions` (preCompact), `message` + `title` (notification) | `docs.github.com/en/copilot/reference/hooks-reference` |
| **pi** | yes | `prompt`, `images`, `systemPrompt`, `systemPromptOptions` (before_agent_start); `message`, `toolResults` (turn_end) | `github.com/earendil-works/pi/.../docs/extensions.md`, `pi.dev/docs/latest/extensions` |
| **omp** | yes | same, plus `messages` + `last_assistant_message` on its Pi-less `session_stop`; `systemPrompt` is an **array** here where Pi's is a string | `oh-my-pi/packages/coding-agent/src/extensibility/extensions/{types.ts,shared-events.ts}` (the repo designates the types canonical; `omp.sh` 403s automated fetches) |
| **opencode** | **no** | its bus events are content-rich (`session.created` → `Session.title` is model-generated; `chat.message` output carries the user's message; `tool.execute.after` output carries the tool output) — but `opencode.ts`'s `mapPayload` builds `metadata: {}` literally, so none of it can reach the column | `github.com/anomalyco/opencode/blob/dev/packages/plugin/src/index.ts`, `packages/sdk/js/src/gen/types.gen.ts` |

Two traps the audit turned up that a name-only fix would have walked past, and which
are the reason the fix has a shape rule as well as a name list:

- **Copilot renames rather than recases** between its two payload forms
  (`toolArgs` ⇄ `tool_input`, `response` ⇄ `last_assistant_message`). A list keyed on
  one form silently misses the other. Both spellings are listed.
- **The biggest surfaces are nested**: Gemini's `llm_request`/`llm_response` hold the
  whole conversation; Claude Code's `background_tasks[]` hold free-text descriptions;
  Pi/OMP's `toolResults[]` hold tool output. Objects and arrays are refused
  outright, so these need no name to be caught.

## What was built

`packages/schemas/src/metadata-safety.ts` — the rule, shared by producer and
consumer, and agent-neutral so a new adapter inherits it rather than opting in:

1. **Name rule** — `CONTENT_BEARING_KEYS`, the payload keys the seven vendors
   document as carrying user or model text, in every spelling they use (snake_case,
   camelCase, and Codex `notify`'s kebab-case).
2. **Shape rule** — `admitsToMetadata()`: objects and arrays are refused, and strings
   are capped at `MAX_METADATA_STRING` (200). This is the half that does not need to
   know a field's name, so it is the half that covers the field nobody has invented
   yet.

Applied to the **passthrough of raw payload keys only**:

- `apps/hook/src/adapters/stdin-hook-factory.ts` — claude-code, codex, gemini-cli,
  copilot.
- `apps/hook/src/adapters/pi-family.ts` — pi, omp.
- opencode and codex-`notify` build `metadata: {}` and need no change.

Values the platform **derives** — `slash_command`, `notification_kind`,
`tool_use_ids`, `source`, `imported` — are added after the filter and are untouched.
That ordering is load-bearing: `tool_use_ids` is an array, so the shape rule would
otherwise delete the P14-006 turn-linkage join key.

`apps/ingest/src/lib/insert-events.ts` applies `stripContentBearingKeys()` — the
**name half only** — to every incoming metadata object. The hook is a binary
developers upgrade on their own schedule, so a server that fixed capture today still
receives the pre-fix shape from every un-upgraded machine for as long as it runs.
Ingest is the choke point an operator controls, and the last one before the value
becomes a durable row. The shape half is deliberately not applied server-side, for
the `tool_use_ids` reason above.

### Exclude, not redact — and why

`prompt` set the precedent, and nothing consumes any of these fields: a repo-wide
grep for `last_assistant_message`, `custom_instructions`, `session_title` and
`background_tasks` outside this change returns nothing. Beyond precedent, redaction
is simply the wrong instrument. `packages/redaction` scrubs **secrets and PII
patterns**; running it over assistant prose leaves the prose intact minus a few token
shapes, which satisfies no one's definition of "never stored". And it would have to
run either in the hook's hot path (forbidden — `apps/hook/AGENTS.md`) or in ingest's
insert path (a regex sweep per event, on the highest-volume write in the system).

### Testing the class, not the instance

`apps/hook/src/adapters/metadata-content-free.test.ts` sweeps **every** adapter in
the `ADAPTERS` registry over **every** hook kind it installs, feeding a payload that
carries every content-bearing key at once, and asserts none survives — checked
against the *serialized* metadata, so a leak under a renamed or nested key is caught
too. Adding an agent to `ADAPTERS` enrols it automatically.

The anti-vacuity half is what keeps that meaningful after a refactor. A builder that
returned `{}` unconditionally would satisfy every assertion above while destroying
the passthrough this test polices, so the sweep also tracks a benign control key and
asserts it still rides through on exactly the six adapters that have a passthrough at
all. Two further guards: the corpus must be non-trivially sized and must name the
specific fields this bug was found in (an emptied list cannot pass silently), and it
must *not* name the structural keys metadata exists to carry (`model`, `turn_id`,
`notification_type`, `timestamp`, `source`) — otherwise the control would be
unrepresentative.

Measured: reverting the filter in the stdin factory alone turns **46** of this file's
assertions red.

On inverting the rule — an explicit allowlist of admissible keys is the airtight
version, and it was rejected. The passthrough exists so an unmodelled vendor field is
*preserved*, and an allowlist deletes exactly that. The shape rule buys most of the
inversion's value (any unknown key is now bounded to one short scalar) without
throwing away the forensic property, and the test enforces the inverted framing —
"content must not appear" — regardless of how the code is structured.

## Blast radius

**What was stored:** for Claude Code, one assistant message per `Stop` and per
`SubagentStop`, plus `PreCompact` custom instructions, the session title and
notification text; for Copilot CLI, every user prompt; for Gemini CLI, every prompt
and agent response; for Pi/OMP, prompts, system prompts and per-turn assistant
messages. Unredacted, in `events.metadata` (JSONB), from the day each adapter shipped
(Claude Code: P8-003; Copilot/Gemini: P12-005/P12-006; Pi/OMP: P12-007/P12-008).

**Where it could be read from:** nowhere that reaches a human, today. `events` has no
Prisma model — it is a raw-SQL-only hypertable, so every read is a `$queryRaw` with
an explicit column list, and the set is enumerable. Exactly one read of the column
exists in the repo: `apps/ingest/src/jobs/link-turn-events.ts` (`stopTurns()`), which
pulls the whole object into job memory and immediately narrows it to
`metadata['tool_use_ids']`; it writes only `turn_number` / `parent_event_id` and puts
nothing in a response, a log line or S3. Checked and clear: `/me/export` (self-only,
reads `sessions`, fixed CSV column list, no per-event rows); the three transcript
routes (`/api/me/transcripts/[id]`, the team-member and org routes — all stream
redacted S3 objects keyed by session id, none touches `events`); org/team/search
queries; the session-detail event list (`sessions-queries.ts`, `LIMIT 500`) which
selects nine named columns and not this one. No JSONB path operator (`->>`, `->`,
`#>>`, `jsonb_*`) appears anywhere in `apps/web`, `apps/ingest` or the SQL
migrations.

**So the exposure is data-at-rest, not disclosure** — anyone with database, backup or
snapshot access, which for a self-hosted deployment is the operator. One structural
caveat worth stating: `interactive_events` is defined `SELECT * FROM events`, and
Postgres froze that column list at creation time — so `metadata` **is** in the view
and reachable by any of the ~90 call sites that read it. None does today. It was one
`e.metadata` away from a dashboard.

## Existing rows: no purge, and why

**No migration and no job.** Three reasons, in order of weight:

1. **The project is pre-deployment.** There is no production instance holding this
   data; the same reasoning closed the backfill question in
   [`P14-006`](./P14-006-live-turn-linkage.md).
2. **A boot-gating migration doing bulk DML on a compressed hypertable is a worse
   risk than the data it removes.** `events` has
   `add_compression_policy('events', INTERVAL '7 days')`
   (`0001_init.sql`), so an `UPDATE` over history decompresses every affected chunk,
   holds locks for the duration, and leaves the table uncompressed until the policy
   catches up. Every service in the stack gates on the migrations runner exiting 0
   (`condition: service_completed_successfully`), so a migration that stalls or fails
   takes the whole deployment down — to clean a column nothing reads.
3. **Nothing reads the column**, per the blast radius above, so the cleanup buys no
   change in who can see what. It is hygiene, not containment.

**For an operator who has already deployed**, the cleanup is one idempotent statement
— run deliberately, off the boot path, with the chunk cost understood:

```sql
-- Strips the content-bearing keys from historical rows. Idempotent; `-` on a
-- jsonb with a text[] is a no-op for keys that are absent.
-- Scope it by time to work chunk-by-chunk rather than locking the whole table.
UPDATE events
SET metadata = metadata - ARRAY[
  'last_assistant_message','last-assistant-message','lastAssistantMessage',
  'assistant_message','assistantMessage','response',
  'prompt','initial_prompt','initialPrompt','prompt_response','promptResponse',
  'transformed_prompt','transformedPrompt','user_prompt','userPrompt','promptText',
  'input_messages','input-messages','inputMessages','message','messages',
  'content','text','images','system','system_prompt','systemPrompt',
  'systemPromptOptions','custom_instructions','customInstructions',
  'compact_summary','compactSummary','session_title','sessionTitle','title',
  'summary','description','instructions','error','error_details','errorDetails',
  'output','result','stderr','stdout','tool_results','toolResults',
  'llm_request','llm_response','diff','patch'
]
WHERE ts >= :from AND ts < :to
  AND metadata IS NOT NULL;
```

Run it per week of `ts` from the oldest chunk forward. Confirm with
`SELECT count(*) FROM events WHERE metadata ?| ARRAY['last_assistant_message','prompt']`.

## Acceptance criteria

- [x] `last_assistant_message` is **proven** present on Claude Code's Stop and
      SubagentStop payloads, from the shipped binary's own schema.
- [x] Every one of the seven adapters is audited against current vendor
      documentation or source, and every content-bearing field found is refused.
- [x] The fix is a shared, agent-neutral rule, not seven per-adapter lists.
- [x] Derived metadata — `slash_command`, `notification_kind`, `tool_use_ids`,
      `source` — is unaffected; `tool_use_ids` in particular still reaches
      `link-turn-events`.
- [x] Ingest strips the same key names on receipt, so a pre-fix hook binary cannot
      write content to a fixed server.
- [x] A test fails when **any** adapter can pass **any** content-bearing field
      through, with an anti-vacuity assertion that survives a refactor.
- [x] Blast radius established by enumerating every read of the column, not by
      assuming.
- [x] Four gates green.

## Files touched

- `packages/schemas/src/metadata-safety.ts` — new; the rule.
- `packages/schemas/src/index.ts` — exports.
- `apps/hook/src/adapters/stdin-hook-factory.ts` — the shared passthrough filter.
- `apps/hook/src/adapters/pi-family.ts` — the same, for the extension-shaped pair.
- `apps/hook/src/adapters/index.ts` — `ADAPTERS` exported so the sweep can enumerate.
- `apps/hook/src/lib/payload.ts` — corrects the comment that read the known-key list
  as the privacy boundary.
- `apps/hook/src/adapters/metadata-content-free.test.ts` — new; the class test.
- `apps/hook/src/adapters/stdin-hook-factory.test.ts` — the notification case now
  asserts the prose is dropped and the derived kind survives.
- `apps/ingest/src/lib/insert-events.ts` — server-side name strip.
- `apps/ingest/test/metadata-content-strip.test.ts` — new; both directions.
- `DESIGN_DOC.md` §9.3 + the `events` DDL comment; `apps/hook/AGENTS.md`;
  `apps/ingest/AGENTS.md`.

## Out of scope

- **`PostToolUse.duration_ms`.** The binary sends it; `buildClaudeToolInfo` still
  hard-codes `duration_ms: 0`. Real per-tool durations for free, but a separate
  change with its own consumers. Already noted in P14-006.
- **`metadata.transcript_path`.** The factory re-adds it deliberately. It is a
  filesystem path, not content — but it is a *pointer* to unredacted content on
  disk, and it appears on Codex, Gemini and Copilot too. It leaks nothing
  `session_context.cwd` does not already carry, so it is left alone; a "pointers to
  content" classification, distinct from ids and enums, would be its own decision.
- **The residual the shape rule cannot close.** A short, top-level, scalar string
  under a name nobody has listed still passes — Gemini's `Notification.details`, whose
  shape its docs do not specify, is the live example. The 200-char cap bounds how much
  of it can be stored; nothing makes it airtight.
- **Migration consolidation / renumbering** — owned elsewhere.
- **Copilot's `permissionRequest` input payload** and **opencode's `Permission`
  fields**: GitHub publishes only the permissionRequest *output* shape, and
  opencode's permission type is undocumented. Neither event is registered by our
  adapters, so neither is a live path today; re-check if either is added.

## Verification

```bash
bun run check && bun run typecheck && bun run build && bun run test

bun run --cwd apps/hook test metadata-content-free
bun run --cwd apps/ingest test metadata-content-strip

# Perf — real hardware only, never trusted from CI
bun run --cwd apps/hook build && bun run --cwd apps/hook bench
```

Hot-path cost: one `Set.has` plus a `typeof` per payload key, inside a loop that
already iterated every key. No allocation, no I/O. Warm-start p50 before/after on the
same machine: `pre-tool-use` 0.30 → 0.29 ms, `post-tool-use` 0.32 → 0.32 ms, `stop`
0.50 → 0.56 ms — inside the run-to-run noise, which on a loaded machine swamps this
change entirely (p99 moved by tens of milliseconds in *both* directions between runs
of identical code).

**Not verifiable here:** anything needing a live database — that the ingest-side strip
writes what its unit test says into real JSONB, that `link-turn-events` still resolves
its ids against rows written through the new path, and the operator purge statement
above. And anything needing a live session of each agent: the vendor payload shapes
are taken from current documentation and source, which is the strongest evidence
obtainable without seven installed CLIs.
