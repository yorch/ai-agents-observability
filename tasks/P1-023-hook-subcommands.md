---
id: P1-023
title: Subcommands (login/status/pause/resume/purge/install)
phase: 1
workstream: D
status: done
owner: claude
depends_on: [P1-019, P1-017]
blocks: []
estimate: M
---

## Goal

The user-facing CLI surface of `aiot`. Everything a developer needs to install, observe, pause, and uninstall the agent.

## Context

- `DESIGN_DOC.md` §11 trust mechanics — `pause`, `resume`, and `purge-local` are non-negotiable.
- Device-code flow lives in P1-017; this task wires it to the CLI.

## Acceptance criteria

- [ ] `aiot login` runs the device-code flow against the configured web app (`AIOT_API` env), prints the user code + URL, polls until authorized, writes `{ token, user_id_claim }` to `~/.aiot/identity.json` (mode 0600).
- [ ] `aiot status` prints:
  - logged-in user (from token claims) or "not logged in"
  - queue depth (events_queue row count)
  - last successful flush timestamp
  - last error message (if any)
  - whether the flusher + shipper services are running
- [ ] `aiot pause` writes a `~/.aiot/paused` marker. Hook entrypoints check this file and exit 0 without writing anything when present. `status` reports paused state.
- [ ] `aiot resume` deletes the marker.
- [ ] `aiot purge-local` removes `~/.aiot/queue.db`, ship markers, log files, and tokens (with confirmation prompt unless `--yes`). Cannot remove anything already uploaded — surfaces a clear message about server-side data and links to the privacy page.
- [ ] `aiot install` writes the launchd/systemd service files and prints the snippet to paste into `~/.claude/settings.json`:
  ```json
  {
    "hooks": {
      "session-start": "aiot hook session-start",
      "pre-tool-use": "aiot hook pre-tool-use",
      ...
    }
  }
  ```
- [ ] `aiot uninstall` removes service files. Does NOT touch local data (use `purge-local` for that).
- [ ] `aiot --help` lists all subcommands; per-subcommand `--help` works.
- [ ] Exit codes documented in README.

## Implementation notes

- Use a small commander/cac-style arg parser (avoid Yargs-level weight).
- For service install, detect platform (`process.platform`); on Linux check for systemd; warn on unsupported environments.
- The pause marker is checked in P1-020's hook entry: add that conditional now (small back-edit to P1-020) and document it here.

## Files touched

- `apps/hook/src/cli.ts` (full subcommand router)
- `apps/hook/src/commands/{login,status,pause,resume,purge,install,uninstall}.ts`
- `apps/hook/src/lib/paths.ts`
- `apps/hook/test/cli.test.ts`
- `apps/hook/README.md`

## Out of scope

- Auto-update.
- Bug-report bundle generation.

## Verification

```bash
bun --filter '@app/hook' test
./apps/hook/dist/aiot-<triple> --help
./apps/hook/dist/aiot-<triple> login
./apps/hook/dist/aiot-<triple> status
./apps/hook/dist/aiot-<triple> pause && ./apps/hook/dist/aiot-<triple> status
./apps/hook/dist/aiot-<triple> resume
./apps/hook/dist/aiot-<triple> purge-local --yes
```
