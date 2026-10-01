# Getting Started

This guide takes you from zero to seeing your AI coding agent telemetry in the
dashboard. It covers installing the hook, wiring up any of the seven supported
agents, importing existing session history, and verifying your data appears.

> **Prerequisite:** an observability server must be running. If you are setting
> up the platform itself, see the [root README](../README.md) for local
> development and [deployment docs](./deploy/README.md) for production.

> **Prefer no background service?** `aiot install --mode on-demand` registers no
> launchd/systemd units: after agent activity the hook starts a short-lived
> process (the drainer) that ships your data and exits. It is the usual choice on
> macOS (to avoid the Login Items prompt a resident service triggers), in
> devcontainers, and in CI. See [Choose how delivery runs](#choose-how-delivery-runs)
> in step 4.

## Supported agents

The `aiot` hook binary captures events from seven AI coding agents.
You can install it for one or more — each agent is wired independently.

| Agent | `--agent` flag | Config location | Transcripts |
|---|---|---|---|
| Claude Code | `claude-code` (default) | `~/.claude/settings.json` | yes |
| OpenAI Codex CLI | `codex` | `~/.codex/hooks.json` or `~/.codex/config.toml` | yes |
| Gemini CLI | `gemini-cli` | `~/.gemini/settings.json` | yes |
| GitHub Copilot CLI | `copilot` | `~/.copilot/hooks/aiot.json` | no |
| Pi | `pi` | `~/.pi/agent/extensions/telemetry.ts` | yes |
| omp (oh-my-pi) | `omp` | `~/.omp/agent/hooks/telemetry.ts` | yes |
| opencode | `opencode` | `~/.config/opencode/plugin/telemetry.ts` | yes |

## 1. Install the hook binary

### Option A — Installer script (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/yorch/ai-agents-observability/main/scripts/install.sh | bash
```

Use `bash -s -- --version v1.2.0` to pin a release or
`bash -s -- --prefix "$HOME/.local/bin"` to install without `sudo`:

```bash
curl -fsSL https://raw.githubusercontent.com/yorch/ai-agents-observability/main/scripts/install.sh | bash -s -- --prefix "$HOME/.local/bin"
```

### Option B — Manual download

Download the binary for your platform from the
[GitHub releases page](https://github.com/yorch/ai-agents-observability/releases/latest):

| Platform | Binary name |
|---|---|
| macOS (Apple Silicon) | `aiot-darwin-arm64` |
| macOS (Intel) | `aiot-darwin-x64` |
| Linux (ARM64) | `aiot-linux-arm64` |
| Linux (x86-64) | `aiot-linux-x64` |

Then make it executable and move it to your PATH:

```bash
chmod +x aiot-<os>-<arch>
mkdir -p ~/.local/bin
mv aiot-<os>-<arch> ~/.local/bin/aiot
```

For checksum verification and air-gapped installation, see
[docs/deploy/hook-binary.md](./deploy/hook-binary.md).

## 2. Configure the server endpoints

If the observability server is running on localhost (the default during local
development), you can skip this step. For a remote deployment:

```bash
aiot config set web-url https://observability.example.com
aiot config set ingest-url https://ingest.example.com
```

Verify with:

```bash
aiot config show
```

## 3. Authenticate

Link the hook to your account so telemetry is routed to your dashboard:

```bash
aiot login
```

This prints a URL and a short device code. Open the URL in your browser, enter
the code, and authorize. Your auth token is stored locally in
`~/.aiot/identity.json`.

**Containers and CI** have no browser to complete the device flow. Set
`AIOT_TOKEN` in the environment instead; it takes precedence over
`identity.json`. The launchd/systemd services of a resident install do not
inherit your shell's environment and still use `aiot login`; an on-demand
drainer receives `AIOT_TOKEN` from the environment of the hook that starts it.
If ingest rejects the token, `aiot login` cannot override the variable; replace
it. See [Containers and CI](#containers-and-ci).

## 4. Install hooks for your agent

`install` does two things: it sets up **how delivery runs** (next section), and
it auto-detects and auto-wires any supported agent harnesses it finds on your
machine. Snippets are printed only for agents it could not detect, so you can
wire them by hand. Run it from the compiled `aiot` binary; from the Bun runtime
it refuses to wire hooks.

### Choose how delivery runs

Hooks only write to a local queue; something then has to deliver it to the
server. `install` offers two ways. Both redact transcripts client-side, enrich
events with git/PR/team context, and use resumable uploads. They differ in what
is left running on your machine.

| | **Resident** (default) | **On-demand** |
|---|---|---|
| Command | `aiot install` | `aiot install --mode on-demand` |
| What runs | Two background services, a flusher and a shipper, registered with launchd (macOS) or systemd (Linux) | Nothing between agent sessions. A Stop, SubagentStop or SessionEnd hook that queued something (or a SessionStart, as catch-up) starts a short-lived detached `aiot drain` |
| When data ships | Within seconds, whether or not an agent is running | Shortly after agent activity; the drainer exits when nothing is due, after at most 120 s |
| What you give up | A service registered with the OS (on macOS, a Login Items prompt and a permanent background process) | Continuous delivery: anything that could not be delivered waits for your next agent session |
| Best for | Workstations where a service is fine and you want delivery independent of agent activity | Macs where you want no Login Items entry, devcontainers, CI, anyone who wants no resident process |

`aiot install` with no `--mode` keeps the mode already recorded (`resident` when
none is), so re-running it after an upgrade, or to wire a newly installed agent,
never turns an on-demand install back into services. To switch, say so:
`aiot install --mode resident` or `aiot install --mode on-demand`. Switching
stops and removes the other mode's units and any running drainer, so the two
never run side by side.

Limits of on-demand mode, stated plainly:

- A drainer can stay alive for up to 120 s after the last hook. It is
  short-lived, not instantaneous.
- Data that could not be delivered (you were offline, the laptop was closed)
  waits on disk until the next agent session starts a drainer. Queued events are
  kept for 7 days by age, and the age limit is only enforced while you have a
  usable token.
- A hard container teardown can lose the last batch, because nothing is left
  running to send it. Run `aiot drain --wait` first (see
  [Containers and CI](#containers-and-ci)).
- A transcript ships at SessionEnd, at the first drain after the session has been
  quiet for 5 minutes, or when its last upload is over 10 minutes old, not on
  every Stop. A session that ends without a SessionEnd (Ctrl+C, a crash, an
  agent with no such hook) ships its transcript tail at the first drain after
  those 5 quiet minutes, which is usually the next session's catch-up drainer.
- An event first delivered after its PR has merged may miss PR linking.

On macOS, the Login Items prompt is why many people choose on-demand: resident
mode installs a LaunchAgent, on-demand installs none. (On managed Macs an MDM
login-items rule may be able to pre-approve the resident LaunchAgent instead;
that is general MDM advice and has not been tested with this binary.) On-demand
mode has been verified on Linux; macOS, and the Rust launcher's role in
starting the drainer, have not been verified end to end.

### Wire your agent

```bash
# Default: Claude Code
aiot install

# For any other agent
aiot install --agent codex
aiot install --agent gemini-cli
aiot install --agent copilot
aiot install --agent pi
aiot install --agent omp
aiot install --agent opencode

# Any of the above in on-demand mode
aiot install --agent codex --mode on-demand
```

If `install` could not auto-wire an agent, copy the printed snippet into the
file indicated by the output. The exact snippet for each agent is also
documented below as a fallback reference.

> **The snippets below are generated by `aiot install --agent <name>`.
> If something does not match, re-run `install` — the binary is the source of
> truth and the snippets may have been updated since this doc was written.**

### Claude Code

Add to `~/.claude/settings.json` (merge with any existing `hooks` object):

```json
{
  "hooks": {
    "Notification": [
      { "hooks": [{ "args": ["hook", "notification"], "command": "~/.local/bin/aiot", "type": "command" }] }
    ],
    "PostToolUse": [
      { "hooks": [{ "args": ["hook", "post-tool-use"], "command": "~/.local/bin/aiot", "type": "command" }] }
    ],
    "PreCompact": [
      { "hooks": [{ "args": ["hook", "pre-compact"], "command": "~/.local/bin/aiot", "type": "command" }] }
    ],
    "PreToolUse": [
      { "hooks": [{ "args": ["hook", "pre-tool-use"], "command": "~/.local/bin/aiot", "type": "command" }] }
    ],
    "SessionEnd": [
      { "hooks": [{ "args": ["hook", "session-end"], "command": "~/.local/bin/aiot", "type": "command" }] }
    ],
    "SessionStart": [
      { "hooks": [{ "args": ["hook", "session-start"], "command": "~/.local/bin/aiot", "type": "command" }] }
    ],
    "Stop": [
      { "hooks": [{ "args": ["hook", "stop"], "command": "~/.local/bin/aiot", "type": "command" }] }
    ],
    "SubagentStop": [
      { "hooks": [{ "args": ["hook", "subagent-stop"], "command": "~/.local/bin/aiot", "type": "command" }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "args": ["hook", "user-prompt-submit"], "command": "~/.local/bin/aiot", "type": "command" }] }
    ]
  }
}
```

Replace `~/.local/bin/aiot` with the actual path to your binary
if you installed it elsewhere.

### Codex CLI

Codex has two wiring modes. The `install` command detects which one to use.

**Default (notify wrapper):** Save this as `~/.codex/aiot-notify.sh`
and `chmod +x` it:

```sh
#!/bin/sh
printf '%s' "$1" | ~/.local/bin/aiot hook turn-complete --agent codex
```

Then point Codex at the wrapper in `~/.codex/config.toml`:

```toml
notify = ["/home/user/.codex/aiot-notify.sh"]
```

**Richer capture (lifecycle hooks):** If you enable experimental hooks in
`~/.codex/config.toml`:

```toml
[features]
hooks = true
```

then re-run `aiot install --agent codex` and write the output to
`~/.codex/hooks.json`. This captures per-tool events in addition to turn-level
data. Not available on Windows.

### Gemini CLI

Add to `~/.gemini/settings.json` (or `.gemini/settings.json` in a project):

```json
{
  "hooks": {
    "AfterAgent": [
      { "hooks": [{ "command": "\"~/.local/bin/aiot\" hook after-agent --agent gemini-cli", "name": "aiot-after-agent", "timeout": 5000, "type": "command" }] }
    ],
    "AfterModel": [
      { "hooks": [{ "command": "\"~/.local/bin/aiot\" hook after-model --agent gemini-cli", "name": "aiot-after-model", "timeout": 5000, "type": "command" }] }
    ],
    "AfterTool": [
      { "hooks": [{ "command": "\"~/.local/bin/aiot\" hook after-tool --agent gemini-cli", "name": "aiot-after-tool", "timeout": 5000, "type": "command" }] }
    ],
    "BeforeAgent": [
      { "hooks": [{ "command": "\"~/.local/bin/aiot\" hook before-agent --agent gemini-cli", "name": "aiot-before-agent", "timeout": 5000, "type": "command" }] }
    ],
    "BeforeTool": [
      { "hooks": [{ "command": "\"~/.local/bin/aiot\" hook before-tool --agent gemini-cli", "name": "aiot-before-tool", "timeout": 5000, "type": "command" }] }
    ],
    "Notification": [
      { "hooks": [{ "command": "\"~/.local/bin/aiot\" hook notification --agent gemini-cli", "name": "aiot-notification", "timeout": 5000, "type": "command" }] }
    ],
    "PreCompress": [
      { "hooks": [{ "command": "\"~/.local/bin/aiot\" hook pre-compress --agent gemini-cli", "name": "aiot-pre-compress", "timeout": 5000, "type": "command" }] }
    ],
    "SessionEnd": [
      { "hooks": [{ "command": "\"~/.local/bin/aiot\" hook session-end --agent gemini-cli", "name": "aiot-session-end", "timeout": 5000, "type": "command" }] }
    ],
    "SessionStart": [
      { "hooks": [{ "command": "\"~/.local/bin/aiot\" hook session-start --agent gemini-cli", "name": "aiot-session-start", "timeout": 5000, "type": "command" }] }
    ]
  }
}
```

### GitHub Copilot CLI

Write to `~/.copilot/hooks/aiot.json`:

```json
{
  "disableAllHooks": false,
  "hooks": {
    "agentStop": [{ "command": ["~/.local/bin/aiot", "hook", "agent-stop", "--agent", "copilot"], "timeoutSec": 5, "type": "command" }],
    "notification": [{ "command": ["~/.local/bin/aiot", "hook", "notification", "--agent", "copilot"], "timeoutSec": 5, "type": "command" }],
    "postToolUse": [{ "command": ["~/.local/bin/aiot", "hook", "post-tool-use", "--agent", "copilot"], "timeoutSec": 5, "type": "command" }],
    "postToolUseFailure": [{ "command": ["~/.local/bin/aiot", "hook", "post-tool-use-failure", "--agent", "copilot"], "timeoutSec": 5, "type": "command" }],
    "preCompact": [{ "command": ["~/.local/bin/aiot", "hook", "pre-compact", "--agent", "copilot"], "timeoutSec": 5, "type": "command" }],
    "preToolUse": [{ "command": ["~/.local/bin/aiot", "hook", "pre-tool-use", "--agent", "copilot"], "timeoutSec": 5, "type": "command" }],
    "sessionEnd": [{ "command": ["~/.local/bin/aiot", "hook", "session-end", "--agent", "copilot"], "timeoutSec": 5, "type": "command" }],
    "sessionStart": [{ "command": ["~/.local/bin/aiot", "hook", "session-start", "--agent", "copilot"], "timeoutSec": 5, "type": "command" }],
    "subagentStop": [{ "command": ["~/.local/bin/aiot", "hook", "subagent-stop", "--agent", "copilot"], "timeoutSec": 5, "type": "command" }],
    "userPromptSubmitted": [{ "command": ["~/.local/bin/aiot", "hook", "user-prompt-submitted", "--agent", "copilot"], "timeoutSec": 5, "type": "command" }]
  },
  "version": 1
}
```

Copilot CLI does not expose transcript paths, so transcript archiving is not
available for this agent.

### Pi

Create `~/.pi/agent/extensions/telemetry.ts` (or `.pi/extensions/telemetry.ts`
in a project):

```typescript
// ~/.pi/agent/extensions/telemetry.ts  (or .pi/extensions/telemetry.ts)
import { spawn } from "node:child_process";

const KINDS: Record<string, string> = {
  before_agent_start: 'user-prompt-submit',
  session_before_compact: 'pre-compact',
  session_shutdown: 'session-end',
  session_start: 'session-start',
  tool_call: 'pre-tool-use',
  tool_result: 'post-tool-use',
  turn_end: 'stop',
};

export default function (pi: any) {
  for (const [native, kind] of Object.entries(KINDS)) {
    pi.on(native, async (event: any, ctx: any) => {
      try {
        const payload = {
          ...event,
          cwd: ctx?.cwd ?? process.cwd(),
          sessionId: ctx?.sessionManager?.sessionId ?? event?.sessionId,
          sessionFile: ctx?.sessionManager?.path ?? undefined,
        };
        const p = spawn("~/.local/bin/aiot", ['hook', kind, '--agent', 'pi'], {
          stdio: ['pipe', 'ignore', 'ignore'],
          detached: true,
        });
        p.stdin.end(JSON.stringify(payload));
        p.unref();
      } catch {
        // Telemetry must never break the agent: swallow and continue.
      }
      // Observe only: this handler never blocks a tool call and never
      // rewrites a result, even though the API allows both.
    });
  }
}
```

### omp (oh-my-pi)

Create `~/.omp/agent/hooks/telemetry.ts` (or `~/.oh-omp/agent/hooks/`, or
`.omp/hooks/` in a project):

```typescript
// ~/.omp/agent/hooks/telemetry.ts   (or ~/.oh-omp/agent/hooks/, or .omp/hooks/)
import { spawn } from "node:child_process";

const KINDS: Record<string, string> = {
  before_agent_start: 'user-prompt-submit',
  session_before_compact: 'pre-compact',
  session_shutdown: 'session-end',
  session_start: 'session-start',
  tool_call: 'pre-tool-use',
  tool_result: 'post-tool-use',
  turn_end: 'stop',
};

export default function (omp: any) {
  for (const [native, kind] of Object.entries(KINDS)) {
    omp.on(native, async (event: any, ctx: any) => {
      try {
        const payload = {
          ...event,
          cwd: ctx?.cwd ?? process.cwd(),
          sessionId: ctx?.session?.id ?? event?.sessionId,
          sessionFile: ctx?.session?.path ?? undefined,
        };
        const p = spawn("~/.local/bin/aiot", ['hook', kind, '--agent', 'omp'], {
          stdio: ['pipe', 'ignore', 'ignore'],
          detached: true,
        });
        p.stdin.end(JSON.stringify(payload));
        p.unref();
      } catch {
        // Telemetry must never break the agent: swallow and continue.
      }
      // Observe only: this handler never blocks a tool call and never
      // rewrites a result, even though the API allows both.
    });
  }
}

// Alternative, if you already run the third-party `omp-hooks` plugin: it makes
// OMP execute settings.json command hooks, so you can wire
// "~/.local/bin/aiot hook <kind> --agent omp" there instead. We ship the native module
// because it needs no third-party package to keep working.
```

### opencode

Create `~/.config/opencode/plugin/telemetry.ts`:

```typescript
// ~/.config/opencode/plugin/telemetry.ts
import type { Plugin } from '@opencode-ai/plugin';
export const telemetry: Plugin = async () => ({
  event: async ({ event }) => {
    const map = {
      'session.created': 'session-start',
      'tool.execute.before': 'pre-tool-use',
      'tool.execute.after': 'post-tool-use',
      'session.idle': 'session-idle',
    };
    const kind = map[event.type];
    if (!kind) return;
    const p = Bun.spawn(['~/.local/bin/aiot', 'hook', kind, '--agent', 'opencode'], { stdin: 'pipe' });
    p.stdin.write(JSON.stringify(event.properties ?? {}));
    await p.stdin.end();
  },
});
```

## 5. Verify

Check that everything is healthy:

```bash
aiot status
```

The first lines are the same in both modes (`auth`, `paused`, `mode`, `queue depth`);
what follows depends on how delivery runs.

**Resident mode** shows the flush and service state:

```text
auth:        logged in as octocat
paused:      no
mode:        resident
queue depth: 0
last flush:  2026-10-01T20:47:25.587Z
last error:  none
heartbeat:    4s ago
flusher:     running
shipper:     running
```

A stale heartbeat with events queued prints a `WARNING` that the daemon may be
stalled.

**On-demand mode** has no daemon, so no heartbeat. It shows whether data is
getting out instead:

```text
auth:           logged in as octocat
paused:         no
mode:           on-demand (no resident service; a drainer runs after agent activity)
queue depth:    0
oldest queued:  none
transcripts pending: 0
last drain:     2026-10-01T20:47:19.619Z (6s ago)
drain lease:    none
last error:     none
```

`oldest queued` is the age of the oldest undelivered event; a stuck queue shows
up as a growing number. `last drain` is the last drain that finished with
nothing owed. `drain lease` names the pid of a drainer running right now. (The
values above are illustrative; the field names and layout are from a real run.)

Then start a session in your agent. After it ends, refresh your
[My Agents](/me) page — the session should appear within a few seconds (in
on-demand mode, once the drainer the session's last hook started has run).

## 6. Import existing session data

If you have historical sessions from before the hook was installed, you can
backfill them. Imported events use deterministic IDs and the server deduplicates
them, so imports are safe to re-run.

### Supported agents for import

| Agent | `--agent` flag | Historical source |
|---|---|---|
| Claude Code | `claude-code` (default) | `~/.claude/projects/**/*.jsonl` |
| Codex CLI | `codex` | `~/.codex/sessions/**/rollout-*.jsonl` |
| opencode | `opencode` | `~/.local/share/opencode/opencode.db` |
| Pi | `pi` | `~/.pi/agent/sessions/**/*.jsonl` |
| omp | `omp` | `~/.omp/agent/sessions/**/*.jsonl` (also probes `~/.oh-omp`) |

> **Gemini CLI and Copilot CLI do not have import sources.** Their session
> data is not stored in a scannable local format that the hook can read.
> Live capture works for both; only historical backfill is unavailable.

### Import commands

```bash
# Preview what would be imported without sending anything
aiot import --dry-run

# Import all history from the default agent (Claude Code)
aiot import

# Import from a specific date
aiot import --since 2026-01-01

# Import from another agent
aiot import --agent codex --dry-run
aiot import --agent opencode --since 2026-01-01
aiot import --agent pi
aiot import --agent omp

# Import a single session (events only, no transcripts)
aiot import --agent codex --session <session-id> --no-transcripts
```

### Import flags

| Flag | Description |
|---|---|
| `--agent <name>` | Select `claude-code`, `codex`, `opencode`, `pi`, or `omp` |
| `--since YYYY-MM-DD` | Skip events older than this date |
| `--session <id>` | Import only one native or normalized session ID |
| `--no-transcripts` | Skip transcript uploads |
| `--dry-run` | Parse and count without posting anything |
| `--quiet` | Suppress per-session progress output |

Authentication (`aiot login`) is required unless `--dry-run` is
passed. Transcripts pass through the same client-side redaction and compression
as live uploads.

## Managing telemetry

| Command | Description |
|---|---|
| `aiot status` | Show auth status, install mode, queue depth, and service state (resident) or drain state (on-demand) |
| `aiot pause` | Temporarily stop sending telemetry |
| `aiot resume` | Re-enable telemetry |
| `aiot install --mode on-demand` / `--mode resident` | Switch how delivery runs; stops and removes the other mode's units and any running drainer |
| `aiot drain` | One delivery pass: send queued events, then ship pending transcripts, then exit. This is what the hook starts; run by hand it prints nothing and exits 0 |
| `aiot drain --wait` | The same pass in the foreground. Waits (up to 120 s) for a running drainer, prints a summary, and exits 1 if any data remains or the pass could not finish |
| `aiot uninstall` | Remove aiot's hooks from every agent config it wired. Resident: also removes the launchd/systemd service files. Either mode: stops a running drainer and resets the mode to `resident`. Local data is kept |
| `aiot purge-local --yes` | Delete all local data (queue, logs, identity). An on-demand install keeps its mode and needs `aiot login` again |

You can also manage privacy settings from the
[Privacy](/me/settings/privacy) page in the dashboard.

## Containers and CI

A container has no launchd/systemd and no browser, so use on-demand mode with a
token from the environment, keep the queue on a volume, and drain before the
container stops:

```bash
export AIOT_HOME=/workspace/.aiot   # a mounted volume, so the queue outlives the container
export AIOT_TOKEN=...               # no interactive login
aiot install --mode on-demand --yes
# ... agent sessions run; hooks queue data and spawn drainers ...
aiot drain --wait || echo "undelivered data remains in $AIOT_HOME"
```

`aiot drain --wait` is the step that prevents a hard teardown from losing the
last batch. Its exit code is 1 when data remains, for example when an
`aiot import` holds the transcripts lease (events are still delivered). The
background drainer starts with a scrubbed environment: it ignores
`INGEST_BASE_URL` from the agent's shell (set the URL with
`aiot config set ingest-url`) but keeps `AIOT_TOKEN` and GitHub credentials.
Details: [docs/deploy/hook-binary.md](./deploy/hook-binary.md#install-without-a-service---mode-on-demand).

## What to look at next

Once data is flowing, explore the dashboard:

- **[My Agents](/me)** — your sessions, costs, and trends
- **[Sessions](/me/sessions)** — searchable session list with transcript viewer
- **[Insights](/me/insights)** — effectiveness signals and friction patterns
- **[Trends](/me/trends)** — your activity over time
- **[PRs](/me/prs)** — sessions correlated to your GitHub pull requests

For the full CLI reference, see [apps/hook/README.md](../apps/hook/README.md).
For deployment details, see [docs/deploy/](./deploy/).
