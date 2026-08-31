# Changelog

All notable changes to this project are documented in this file.

The format is based on [Conventional Commits](https://conventionalcommits.org/)
and generated automatically by `scripts/prepare-release.sh` as part of the
release workflow (`.github/workflows/release.yml`).

## v2.3.0 (2026-08-31)

### Features

- effectiveness: add real-time session stream for team leads (#222)
- effectiveness: add prompt pattern mining on /org/prompts (#221)
- effectiveness: add session comparison/diff view (#220)
- cost: add model routing simulation on /org/models (#219)
- cost: add per-team cost anomaly detection and alerting (#216)
- security: add secret-exposure alerting and recent-exposures table (#215)

## v2.2.0 (2026-08-31)

### Features

- security: trusted proxy, hook token revocation, scratch perms, admin hardening, binary signing (#210)

### Bug Fixes

- redaction: widen perf test thresholds to stop CI flakes (#211)

## v2.1.0 (2026-08-30)

### Features

- security: security headers, S3 SSE support, expanded redaction rules (#207)

### Performance / Refactors

- docker: slim ingest/github-app images and multi-stage migrations runner (#208)

## v2.0.1 (2026-08-30)

### Bug Fixes

- security: fail-closed audit logging, login rate limiting, git URL redaction, SECURITY.md (#205)

## v2.0.0 (2026-08-30)

### Breaking Changes

- rename hook binary from claude-telemetry to aiot (#197)

### Features

- hook: add Rust launcher and auto-detect agent harness wiring (#202)
- hook: harden install scripts and activate services by default (#192)

### Bug Fixes

- hook: harden installer and prompt, add install flag tests (#204)
- hook: safe-quote opencode plugin path and update docs for auto-wire (#203)
- hook: use /health instead of /readyz for import pre-flight check (#201)
- observability: suppress successful metrics access logs (#199)
- traefik: allow GET /readyz on ingest router (#198)
- auth: prevent premature logout by extending access token TTL and adding client-side refresh (#196)
- auth: surface GitHub error details in device flow failures (#193)

## v1.4.1 (2026-08-29)

### Bug Fixes

- auth: show OAuth callback errors on login (#186)
- auth: make generated JWT keys Compose-safe (#185)
- deploy: support Traefik v2 ingest routing (#183)

## v1.4.0 (2026-08-28)

### Features

- hook: persist endpoints and import agent history (#179)

### Bug Fixes

- deploy: harden Traefik service exposure (#182)
- auth: use canonical OAuth callback origin (#180)

## v1.3.0 (2026-08-28)

### Features

- ingest: schedule aggregate report digests (#177)
- web: deepen scoped report analytics (#176)
- launch Agentometry product and docs site (#169)
- separate development and production setup (#171)
- web: add advanced analytics and richer digests (#168)

### Bug Fixes

- exclude the Pages site from synchronized releases (#174)
- support older just versions (#173)

## v1.2.0 (2026-08-28)

### Features

- web: enrich reports with scoped trends (#164)
- web: add portable report bundle export (#162)
- web: add session visual analysis (#161)
- web: add scoped activity trends (#163)

### Bug Fixes

- seed: make seeded telemetry match what production records (#160)

## v1.1.0 (2026-08-28)

### Features

- web: add scoped agent reports and exports (#151)

### Bug Fixes

- web: stop reporting suppressed routing spend as efficient routing (#156)

## v1.0.0 (2026-08-28)

### Breaking Changes

- Phases 7–9, Codex adapter, and UPPER_SNAKE_CASE enum + migration overhaul (#52)

### Features

- docker: add semver major/minor Docker image tags (#150)
- release: two-phase release process with human approval gate (#146)
- deploy: Helm chart for Kubernetes + deployment docs index (#145)
- deploy: build-from-source Compose overlay (#144)
- deploy: supply-chain hardening, air-gapped bundle, hook release (#143)
- deploy: standalone server binaries + web tarball (#142)
- ingest: reconcile spend against GitHub's billing API (#140)
- ingest: price request-denominated agents alongside token-denominated ones (#137)
- ingest: join transcript turn linkage onto live tool events (#126)
- hook: capture per-turn token usage for Copilot CLI (#124)
- hook: capture per-turn token usage and turn linkage for Claude Code (#120)
- schemas: emit the real tool-category taxonomy from the adapter seam (#118)
- ingest: turn-linked cost attribution for tools, skills and sub-agents (#119)
- policy: close Phase 10 — shared per-agent model policy, savings ranges, and governance (#115)
- scores: Phase 13 — scoring substrate, run_kind isolation, and evaluation groundwork (#110)
- ingest: reprice historical cost, and price the models nothing priced (#114)
- web: UI/UX review, implementation of its findings, and review-driven hardening (#112)
- hook: expand the adapter seam to seven agents (Phase 12) (#111)
- web: close out the revamp — primitives, accent scale, and full adoption (#103)
- web: revamp the UI — finish the token layer, add ui primitives, replace the stacked navs with a rail (#101)
- ingest: real reconcile-cost billing client (Anthropic Cost Report API) (#94)
- redaction: add email (PII) and git-remote-url credential rules (#93)
- routing accountability, true Jira business-value join, redaction-flag backfill (#92)
- price-precise routing + waste alert, business-value join, user_id on tool/model aggregates (#91)
- web: replace emoji/Unicode glyphs with custom SVG icons (#89)
- web: redaction-class security report, routing recommendations, cohort/temporal depth, cagg-backed cost rollups (#88)
- web: surface captured-but-unused metrics + add security, forecast & knowledge dashboards (#86)
- db: broaden seed coverage across all collected data (#87)
- quality: Fisher's exact significance testing on friction-band deltas (#85)
- correlation: project-key allowlist, bug analytics, defect attribution, quality page (#84)
- correlation: deepen session↔PR↔repo↔Jira correlation and surface it (#83)
- hitl: human-in-the-loop observability — autonomy capture, oversight dashboards & governance (#76)
- web: add request-correlated structured logging to API routes (#80)
- complete alerting (budget + SMTP), add ROI dashboard, and friction coaching (#75)
- web: add time range picker to all org analytics pages
- web: extract shared team-org components, fix org nav height, and move OrgSubNav to layout
- web: agents tab, models page, and shared team-org components
- web: team MCP page + clickable session rows
- web: MCP integrations dashboard at /org/mcp
- web: owner-initiated session sharing
- web: skills analytics pages with drill-down detail views
- web: team & org navigation, insights, and time-range filters
- seed: add subagent telemetry data for demo
- skills: expose skills telemetry across personal and org dashboards
- team-org: dashboard improvements — date range, deltas, PR tab, adoption funnel, cache efficiency, model governance (#68)
- web: org-level adoption, delivery, and benchmarks analytics (#66)
- web: redesign transcript viewer with parse layer and conversation mode
- db: add --extensive seed mode with realistic multi-user data (#67)
- capture git at session start; add is_draft to pull_requests (#64)
- hook: pre-flight server readiness check before import (#65)
- ingest: P7-007 semantic transcript search spike (#62)
- ingest: improve structured logging across events, middleware, and job scheduler (#63)
- web: introduce /me/settings shell with vertical sidebar nav (#61)
- hook: add email/password login fallback when GitHub OAuth is not configured (#60)
- web: add /me/profile page for self-service profile editing (#59)
- web: add /org/tools — tool, skill & MCP usage analytics for org admins (#58)
- db: add ORG_ADMIN seed user + gitignore tmp/
- hook: add aiot import command for historical session import (#56)
- web: surface session cost, friction trend, and shape distribution in /me/insights (#57)
- web/design: redesign the UI
- db: seed a password-only user for immediate local login
- web: price tables, adapter health, and investigator grants UI (#55)
- hook: capture skill and slash command usage from Claude Code events (#54)
- web: navigation fixes + insights page, export CSV, and date range picker (#53)
- web: complete full agent session save & display (org access, streaming, zstd, §8.4) (#51)
- complete stubbed telemetry gaps + Phase 6 hardening (#49)
- auth: add `bun run gen:keys` JWT keypair generator (#47)
- add email/password login alongside GitHub OAuth (#40)
- p4-p5: metrics, revert detection, Jira, GitHub Checks, multi-agent, configurable jobs (#33)
- P3: team views — role middleware, overview, roster, member drill-in, audit, privacy (P3-001 → P3-007) (#32)
- docker: matrix build/publish workflow (+ fix unbuildable bun Dockerfiles) (#17)
- P2: Phase 2 — PR Loop implementation (#14)
- P1-023: hook subcommands — login/status/pause/resume/purge-local/install/uninstall (#9)
- P1-018/021/022/025/026/027 — hook pipeline + /me web UI (#7)
- Phase 1 tasks P1-011 / P1-012 / P1-020 / P1-024 + review fixes (#6)
- Phase 1 spine — ingest routes, hook binary, OAuth flows, seed (#5)
- P1-006/007/008/009/014/015 — schemas, redaction, auth, github, ingest service (#4)
- Track A — docker-compose stack, Prisma schema, Timescale hypertable (P1-002/003/004) (#3)
- P1-001: monorepo bootstrap — Bun workspaces + Turborepo + Biome (#2)

### Bug Fixes

- ingest: let the DB-gated suites share a database (#136)
- build: typecheck the migrations runner and drop the empty-Config casts (#134)
- build: bring the test directories inside the typecheck gate (#132)
- hook: capture real per-tool durations instead of hardcoding zero (#131)
- hook: stop passing model and user content through to events.metadata (#127)
- web: make the model-routing surfaces read real cost instead of seed fiction (#125)
- web: correct sub-agent identification and stop reporting fabricated tool cost (#117)
- ingest: refresh every price table and correct provider token accounting (#113)
- restore clobbered ignore rules, then normalize them (env, .vscode, data/) (#100)
- docker: skip lifecycle scripts in the deps stage (#98)
- ingest: satisfy exactOptionalPropertyTypes in DispatchOptions (#79)
- logging: close gaps across services (#77)
- web: replace hardcoded shape labels with live GROUP BY on /me/sessions (#69)
- web: guard null github_login in skill top-users query and keys
- a11y: add text-bg to all bg-brand-500 buttons for sufficient contrast
- web: handle ChecksumStream from AWS SDK when streaming transcripts
- docker: remove cross-file depends_on from docker-compose.app.yml
- ingest: return 503 on S3 storage errors instead of propagating to onError
- ingest: match ON CONFLICT target to events unique index (event_id, ts)
- web: replace non-null assertion in McpTable grouping loop
- web: fix CSV export route (wrong SessionRow fields, pagination, lint)
- types: resolve exactOptionalPropertyTypes and Prisma JSON typecheck errors
- ingest: commit missing codex/opencode price tables; un-ignore src/data
- web: repair PR detail links, seed, team access, post-login nav (#45)
- auth: pass maxmem to scrypt so password login works (#44)
- dev: load root .env in native dev + run migrations in docker:infra (#43)
- resolve all build and quality gate failures (#41)
- docker: make prod stack work out-of-the-box + fix observability gaps (#37)
- include Prisma generated client in Next.js standalone bundle (#36)
- db: include ts partition column in events_event_id_key unique index (#35)
- address review findings across hook, ingest, github-app, web, packages (#31)
- docker: traefik.yml — !reset host ports + fail-fast DOMAIN_* (#27)
- add version build args to github-app and ingest Dockerfiles
- 9 post-review bugs — shipper/ingest HTTP contract, date validation, client component (#8)

### Performance / Refactors

- cost: let the seed and ingest share one attribution implementation (#130)
- migrations-runner: drop the recursive chown (#106)
- web: make control size a scale, and land every control on it (#104)
- ingest: unify request timing/metrics in one middleware, share a logger factory (#78)
- seed: improve summary output for basic and extensive seed
