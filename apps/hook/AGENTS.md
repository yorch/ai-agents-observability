# apps/hook — agent notes

> `CLAUDE.md` here is a symlink to this file. Edit `AGENTS.md`.
>
> **Root rules still apply.** Claude Code concatenates this file with the repo-root
> [`AGENTS.md`](../../AGENTS.md); some other agents load only the *nearest* file.
> The invariants most expensive to lose are restated here for that case:
> four gates before every commit (`bun run check` → `typecheck` → `build` → `test`);
> `packages/schemas` is the only source of telemetry event shapes; and **transcripts
> pass `packages/redaction` before they leave the machine** — this app is where that
> first pass happens.
>
> See [`README.md`](./README.md) for the binary's *user-facing* CLI surface. This file
> is for changing the code.

The developer-facing artifact: a Bun single-binary CLI that installs as the host
agent's hook, captures events, and ships them to ingest. It is **not a server**.

## The adapter seam

Per-agent capture lives in `src/adapters/` — `claude-code.ts`, `opencode.ts`,
`codex.ts`, dispatched through `index.ts`. The seam was extracted from two real
agents (P8-003/P8-004), not designed up front, and codex (P8-007) validated it.

**Adding an agent is a new adapter, not a schema change.** If you find yourself
widening `packages/schemas` to fit an agent, the adapter is doing too little.

Known asymmetry: opencode's history is *directory*-shaped, so the single-file
transcript shipper doesn't cover it. That's a live follow-up, not an oversight.

## Two hard invariants

- **`hook <kind>` always exits 0.** A broken hook must never interrupt the host agent.
  `hook-entry.ts` swallows everything; errors go to the log file only. If you add a
  code path here, it cannot throw past the top level.
- **The hot path stays tiny.** `hook-entry` writes one row to the local SQLite queue
  (WAL mode) and exits. No network, no redaction, no parsing beyond what the write
  needs — the flusher and shipper do that work out-of-process.

## The perf budget, stated honestly

The design target is **<10 ms** added wall time on developer hardware
(`DESIGN_DOC`/`PLAN` Phase 1 exit criterion). `.github/workflows/perf.yml` benchmarks
cold start against a **<15 ms p99** budget — and it is **`continue-on-error: true`,
i.e. report-only**. On shared `ubuntu-latest` runners a Bun single-file-binary cold
start measures ~60–80 ms regardless of your code, so the number there is a trend line,
not a gate. Results upload as an artifact with 90-day retention.

**Do not treat a green perf job as proof you stayed in budget.** Run
`bun run --cwd apps/hook bench` locally on real hardware.

## Layout

```text
src/
  cli.ts           # entry; commands/ dispatch
  hook-entry.ts    # the <10ms hot path — stdin JSON → SQLite queue → exit 0
  flusher.ts       # long-running: drains queue, batches → POST /v1/events
  shipper.ts       # long-running: redacts + zstd + chunk-uploads transcripts
  adapters/        # per-agent capture (the seam)
  commands/        # login install uninstall status pause resume purge import
  lib/             # queue (WAL), git, identity, payload, transcript parsing, backoff
```

## Building

`bun run build` compiles for the current platform; `build:all` cross-compiles all four
distribution targets (`darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`) via
`bun build --compile --target bun-<os>-<arch>`. The output is a standalone executable —
no Bun or Node needed on the developer's machine. Binaries land in `dist/` at 50–80 MB
(the Bun runtime is bundled); Mac distribution beyond dev machines needs codesigning +
notarization (see `README.md`).
