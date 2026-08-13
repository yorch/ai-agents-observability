# UI/UX Review & Gap Analysis — August 2026

**Scope:** full review of `apps/web` (59 pages, ~143 source files) against current UX/accessibility best practice for enterprise analytics/observability dashboards.
**Method:** structural map of every route/primitive/chart, an evidence-based code audit (loading/empty/error states, a11y, responsive, formatting, performance UX), and external research (NN/g, W3C/WCAG 2.2, UK Gov Analysis Function, Carbon, vendor practice from Datadog/PostHog/Swarmia). All findings cite `file:line`; the flagged bugs were individually re-verified in the working tree.
**Relationship to prior work:** the [Instrument direction](./ui-direction.html) (2026-08-01) has landed — semantic tokens, rail navigation, shared primitives, and the chart grammar are real and consistently used. This review starts where that one ended: it assesses the post-revamp state and identifies the next tier of gaps.

---

## 1. Where the app stands

The foundation is genuinely strong, and unusually disciplined for a hand-rolled system:

- **Token layer** — dark/light both work; ink steps documented AA on both grounds (`globals.css:101`); CVD-validated series palette with measured ΔE (`globals.css:74-83`); accent swaps lime→olive in light because lime is 1.2:1 on white (`globals.css:145-147`). No raw palette utilities remain.
- **Primitives** — one `Card`/`Stat`/`Table`/`Badge`/`Field`/`FilterPanel`/`Segmented`/`Pagination` layer; no raw `<table>`s; control heights aligned to button heights; zero component-library dependencies.
- **Architecture-level UX wins** — URL-as-state filtering throughout via GET forms (shareable, bookmarkable, back-button-safe — this is the canonical pattern); only ~15 client components in the whole app; charts are server-rendered SVG with one delegated hover listener; the transcript viewer streams NDJSON with DOM windowing.
- **Trust design** — "My Agents" first, conservative sharing defaults, audit-feed visibility of privileged access, and privacy-filtered facet dropdowns (`org/search/page.tsx:47` excludes opted-out users from filter lists so participation can't leak). This matches the published SPACE/Swarmia guidance for developer-telemetry tools almost point for point.

The gaps below are therefore mostly *the next layer up*: feedback loops, resilience states, keyboard/AT access, and consistency at the seams — not structure.

---

## 2. Confirmed bugs (fix first — all verified)

| # | Bug | Evidence |
|---|-----|----------|
| B1 | **The three brand fonts never load.** `globals.css:22-24` maps `--font-display/body/mono` to `var(--font-syne)` etc. and the comment says they're "injected by next/font/google" — but `next/font` is imported nowhere in the repo and those variables are defined nowhere. Every page silently falls back to `ui-sans-serif`/`ui-monospace`. (`font-mono` still gets `tabular-nums` from `globals.css:179`, which is why nothing looked obviously broken.) | `globals.css:4,22-24`; `grep -rn "next/font" src/` → 0 code hits |
| B2 | **Session-table pagination discards all active filters.** `SessionsTable.tsx:155,163` and `TeamSessionsTable.tsx:145,153` hand-roll a pager with `href={`?page=${n}`}` — on `/me/sessions?repo=foo&status=CRASHED`, "Next" navigates to `?page=2` and silently clears all 8 filters. The shared `ui/Pagination` + a `buildUrl`-style `hrefFor` (as `org/search/page.tsx:378-384` and `me/prs/page.tsx:141` already do) exists precisely to prevent this. | `SessionsTable.tsx:146-171` |
| B3 | **The audit-log action filter never applies.** `me/settings/audit/page.tsx:12` validates against uppercase `VIEW_SESSION`… but the `<Select>` options are built from `ACTION_LABELS` whose keys are lowercase `view_session`…, so `VALID_ACTIONS.has(action)` is always false and the filter is a no-op (and its "Clear" button never appears). | `me/settings/audit/page.tsx:12,20-24,40-41` |
| B4 | **"Saved" shown on failure.** `PrivacyForm.tsx:106-109` awaits the server action then unconditionally `setSaved(true)` — a server-side failure renders green "Saved" on the *privacy settings* form, the one form where false success is most corrosive to trust. `SessionFeedbackForm.tsx:34-37` has the same bug. `ProfileForm.tsx:28-34` shows the correct pattern (branches on `result.ok`). | `PrivacyForm.tsx:106-109` |
| B5 | **Two dead links to `/me/privacy`** (real route is `/me/settings/privacy`) — from the install page and the team roster's privacy notice, both landing on Next's default unthemed 404 (no root `not-found.tsx`, see G2). | `install/page.tsx:149`, `team/[slug]/roster/page.tsx:113` |
| B6 | **CI status truncated to 4 chars** — `r.ciStatus.slice(0, 4)` renders "succ"/"fail", visually collision-prone and colour-dependent to disambiguate. | `org/tools/page.tsx:549` |

---

## 3. Gap analysis

### G1 — Loading & perceived performance: the app has a token-perfect skeleton system that almost nothing uses

**Found:** zero `<Suspense>` boundaries in the app; 55 of 59 pages are `force-dynamic` and each blocks on its full `Promise.all` before any HTML ships (e.g. `me/page.tsx:37-46` gates on seven queries; `org/search/page.tsx:56-101` on six). Only 3 `loading.tsx` files exist (root, `/me`, `/me/prs`); all of `/org` (16 routes), `/team` (11), `/admin` (8) fall through to the root's bare "Loading…" text (`app/loading.tsx:2`) — a shapeless flash on pages whose real content is a stat grid plus charts. No `prefers-reduced-motion` handling on the three `animate-pulse` surfaces.

**Best practice:** Next.js's own dashboard guidance is granular per-section Suspense with dedicated skeletons so fast sections render immediately and slow queries stream in; skeletons must replicate the real layout or they add jank; zero layout shift (CLS ≤ 0.1) requires pre-allocated space. Facet queries that don't change per page shouldn't re-block page navigation (on `/me/sessions`, moving to page 2 re-runs `listDistinctRepos` + two `groupBy` facet queries — `me/sessions/page.tsx:92-101`).

**Recommend:**
1. Add `loading.tsx` to `/org`, `/team/[slug]`, `/admin`, `/me/sessions`, `/me/insights` mirroring each page's stat-grid + card shape (the `SkeletonCard`/`SkeletonBar` primitives already exist).
2. Introduce per-section `<Suspense>` on the heaviest pages (org dashboard, org search, me overview) so the header and first stat row paint before the slowest query resolves.
3. Wrap pulse animation in `motion-reduce:animate-none`.

### G2 — Error handling: failures are either silent or unstyled

**Found:**
- No `global-error.tsx` — yet the root layout does DB work (`layout.tsx:17,23-28`), and a layout throw bypasses `app/error.tsx`, landing on Next's unstyled crash page exactly when the DB is down.
- No root `not-found.tsx` — every `notFound()` outside `/team/[slug]` and `/me/prs` (e.g. `org/sessions/[id]/page.tsx:43,53`) renders the default black-and-white 404, without rail or theme.
- No per-segment `error.tsx` — one failed query on `/org/roi` blows away the whole page including navigation.
- **Server actions fail completely silently.** Every admin action returns `Promise<void>` and bails on invalid input with no signal: retention (`admin/retention/actions.ts:29-31` — "ignore invalid input"), self-demotion guard (`admin/org-roles/actions.ts:31-33`), grant validation (`admin/access-grants/actions.ts:28-36`), job config (`admin/jobs/actions.ts:14-24`). The admin sees the form reset and nothing else. There's also no *success* feedback on any admin mutation — every action ends in `revalidatePath()` and silence.
- No toast/notification primitive exists, so there is nowhere to put feedback that survives scroll on long admin pages.
- `triggerJob` gives no acknowledgement: after "Run now" the row still shows the previous run's status until the next 60s scheduler poll (`admin/jobs/page.tsx:56-57,143-154`).

**Recommend:**
1. Add `app/global-error.tsx` and `app/not-found.tsx` (themed, with a way back); add `error.tsx` to the four section segments.
2. Migrate server actions to a `{ ok, error }` return shape consumed via `useActionState` — `ProfileForm` already demonstrates the pattern; apply it to every admin form and render inline field-level messages for the validation rules that currently discard input silently.
3. Add a small toast primitive (or a persistent inline status row on admin pages) for action outcomes; show a "queued…" state on `triggerJob` rows (the `runRequestedAt` timestamp already exists to drive it).

### G3 — Accessibility: strong colour system, weak keyboard/AT story

The colour/contrast layer is exemplary. The interaction layer is where WCAG 2.2 conformance currently fails:

- **Focus is nearly invisible.** `Button.tsx:10` has no `focus-visible:` ring; only `Field.tsx:14` and `PrivacyForm.tsx:33` define focus styles anywhere. Every nav link, segmented option, table link and tab relies on the UA default outline on a `#0a0a0e` ground. WCAG 2.2 makes focus appearance/visibility more prominent (SC 2.4.11 Focus Not Obscured is now AA).
- **Chart tooltips are hover-only** — `ChartHover.tsx:23,51` listens only to pointer events; marks are plain `<span>`s with no `tabIndex` or accessible name; on stacked `BarChart`s the values exist *only* in the tooltip. This fails SC 1.4.13 (content on hover must be dismissible/hoverable/persistent) and SC 2.1.1 (keyboard). The standard remedies: focusable marks, plus a data-table fallback per chart (W3C complex-image pattern; Carbon recommends an alternative table view for every visualization). `FrictionSourcesChart.tsx:64-75` already shows the right shape — visible list mirroring the chart data.
- **`title`-attribute-only data** (invisible to touch and most screen readers) across ~12 sites: `DailyTrendBars.tsx:28` (the entire daily series), `ShareBar.tsx:31` (every segment value), `org/adoption/page.tsx:182`, `org/delivery/page.tsx:115`, etc.
- **No skip link**, and `<main>` has no `id`/`tabIndex` (`layout.tsx:63`) — keyboard users tab through ~20 rail items on every page.
- **Dialogs aren't dialogs.** The share popover sets `role="dialog"` but never moves focus in, has no trap, no restore, no `aria-modal` (`ShareSessionButton.tsx:99-104`); the mobile nav drawer likewise (`Rail.tsx:98-104`). There is no dialog/modal primitive in the system — one is needed anyway for G5.
- **Tabs without tab semantics** — `SessionDetailTabs.tsx:38-54` is plain `<a>`s with no `aria-current` (the codebase's own `Segmented.tsx:40` does this correctly).
- **Search `<mark>` unthemed** — `me/search/page.tsx:114` / `org/search/page.tsx:279` inject `<mark>` with browser-default black-on-yellow onto the dark surface.
- **Target size** (new SC 2.5.8, AA): the 10px "Revoke" text button (`ShareSessionButton.tsx:120-130`) and similar text affordances likely fall under 24×24px.
- Biome runs recommended rules only — no `a11y` rule group enabled (`biome.json:36-53`), so none of this regresses loudly.

**Recommend (ordered):** focus ring in `Button` base + a global `focus-visible` convention; skip link + `main` target; style `mark`; add `aria-current` to `SessionDetailTabs`; a proper dialog primitive used by share popover + drawer; keyboard/table fallbacks for charts (start with `BarChart`, the only place data is tooltip-only); enable Biome's a11y rules to lock it in.

### G4 — Consistency at the seams: formatting and empty states

This is the weakest area relative to the discipline elsewhere, and it's all mechanical:

- **`lib/fmt.ts` has 13 importers; ~20 local reimplementations bypass it.** `formatDuration` exists four times with two output formats ("1h 5m" vs "65.0m" vs "1.5s"-on-milliseconds); `formatDate` three times; `fmtTokens` three times with different thresholds.
- **The same session cost renders at three precisions** depending on the page: 3dp in lists (`SessionsTable.tsx:124`), 4dp in detail (`SessionDetailHeader.tsx:54`), 2dp in org rollups — the number visibly changes shape as you click from list to detail. One team stat row mixes 2dp and 3dp (`team/[slug]/agents/page.tsx:44,50`).
- **~95 `toLocaleString()` calls with no locale or timezone** — SSR renders in the *server's* zone with no indication; `'en-US'` is hard-pinned in five places and left `undefined` in others, so two charts on one page can label the same week differently. Job schedules are explicitly UTC while the alert history beside them is server-local (`admin/jobs/page.tsx:139` vs `admin/alerts/page.tsx:229`). Trailing-window math is server-local ms while labels say "trailing 30 days" (`lib/time.ts:1-3`).
- **Empty states have three parallel conventions:** the `EmptyState` primitive (24 sites), bare `<p class="text-sm text-text-3">` (45+ sites, e.g. `org/dashboard/page.tsx:193,230,259`), and chart-local strings — with unsystematic wording ("No data available." / "No data." / "No data yet." / "No data in this period." / "No data in this window." / "Nothing recorded yet."). Only one `EmptyState` in the app supplies an `action` (`me/page.tsx:64`); every other is a dead end — notably `SessionsTable.tsx:60` ("No sessions found") on a page with 8 active filters and no "clear filters" escape. NN/g's rule: never dead-end; distinguish first-use ("install the hook" — already done well) from zero-results ("clear filters / widen range"). Two components render nothing/headers-only when empty (`DailyTrendBars.tsx:14-16`, `AgentsTable.tsx:12`).
- **Silent truncation:** `org/governance/page.tsx:132` shows 30 rows under an unqualified heading; org search shows max 20 transcript matches with no "top 20" note (`org-queries.ts:1515`) while session results below are paginated. (`org/dashboard/page.tsx:190,225` gets this right — "(top 10)".)

**Recommend:** one PR that (a) routes all currency/duration/date through `lib/fmt.ts` with a pinned locale and explicit UTC (plus a rendered zone hint where timestamps matter), deleting the duplicates; (b) converts bare-paragraph empties to `EmptyState` with a standard wording set (first-use vs zero-results vs job-not-run-yet) and adds `action` links (clear-filters on filtered tables); (c) labels every capped list "top N". Then add the conventions to `apps/web/AGENTS.md` so they hold.

### G5 — Destructive actions have no confirmation

`DeleteDataButton.tsx:12-14` (`window.confirm` + persistent success state) is the only confirmed destructive flow. Meanwhile every admin destructive action is a bare one-click submit: revoke access grant (`admin/access-grants/page.tsx:80-87`), delete notification channel (`admin/alerts/page.tsx:170-175`), revoke team-lead (`admin/team-roles/page.tsx:64-71`), revoke session share (`ShareSessionButton.tsx:120-130`), and — most notably — **bulk-approve all pending grants** (`admin/access-grants/page.tsx:130-139`), which fans out audit-visible approvals for an unbounded set with no count confirmation. Once the dialog primitive from G3 exists, these are its first consumers (a `window.confirm` interim is fine and one line each).

### G6 — Responsiveness: the shell adapts; a third of the pages don't

The rail collapses properly and tables scroll in their own container. But 37 of 59 pages contain zero breakpoint prefixes — including all 8 `/admin` pages and all of `/me/settings`. Specific breaks: ten fixed `grid-cols-3` stat rows never collapse (each tile is `font-mono text-2xl` — three don't fit at 375px; e.g. `me/prs/page.tsx:176`, `org/delivery/page.tsx:134`, `team/[slug]/tools/page.tsx:48`); the settings layout hard-codes a 192px sidebar with no mobile treatment, leaving ~103px of content on a phone (`me/settings/layout.tsx:10-13`, `SettingsNav.tsx:18`); admin `inline-flex` input+button rows inside table cells don't wrap (`admin/retention/page.tsx:55`). Given the audience is developers at desks, mobile is secondary — but the `/me` surfaces (the trust anchor, and the ones a dev might open from a phone) and the stat grids are cheap fixes: `grid-cols-2 md:grid-cols-3` and a stacked settings nav.

**A related note:** horizontal-scroll tables give no affordance that more columns exist off-screen (9 columns on `/me/sessions`). A subtle edge-fade on the scroll container is the low-cost fix.

### G7 — Filtering & tables: solid mechanics, missing the "state visibility" layer

The GET-form/URL-state architecture is the right foundation (it's the canonical pattern) and clear buttons are derived from a single filter object so they can't drift. What the research says comes next, in order of value:

1. **Applied-filter chips** — a row above results showing each active filter with per-chip remove + "Clear all". With 8+ facets on `/me/sessions` and `/org/search`, the only current signal of active filters is the form fields themselves, which collapse into a panel. (Enterprise-filtering guidance calls for filter state visible in three places: control, group badge, chips row.)
2. **Zero-result recovery** — ties into G4: on empty filtered results, say *which* filters applied and offer one-click clear.
3. **Saved views** — named per-user filter+sort presets with permalinks; the marquee upgrade for data-heavy tools, and cheap here because a view is just a URL.
4. **Table sorting** — no table in the app is user-sortable; org/team analytics tables render at their SQL `LIMIT` in query order. Server-driven sort via a `?sort=` param fits the GET architecture as-is. (Deliberate caveat below in G9 about sortable per-person cost columns.)
5. **Column count on phones** aside, pagination exists on the four highest-volume lists — but `PAGE_SIZE` is independently defined in five files and can drift between the table's `totalPages` math and the query's actual page size; centralize it.

### G8 — First-run: the install flow exists; the "waiting for first event" loop doesn't

`/install` plus the `me/page.tsx:61-67` empty state ("No sessions yet → Install the hook") is a good static version of the industry pattern. The convergent vendor pattern (Datadog/PostHog/Sentry) adds one step this app is well-positioned for: after install, a **live listening state** — "waiting for your first event…" that polls and flips to the dashboard when telemetry arrives, confirming the hook actually works end-to-end. The hook already has `status`/device-code flows; a small polling endpoint + a client island on `/install` (or the `/me` empty state) closes the loop. This is the single highest-leverage adoption surface for a tool whose value depends on every dev completing setup.

### G9 — Trust & metrics presentation: mostly exemplary — two watch-items

Against SPACE/DORA/Swarmia guidance (no leaderboards, team-level default altitude, symmetric visibility, individual data as self-serve not evaluation), the design is already aligned — this is the app's differentiator and worth protecting deliberately:

- **Watch-item 1: rankable per-person tables.** Team/org session tables include per-engineer cost and friction columns; today they aren't sortable (see G7-4). When adding sorting, *deliberately exclude or de-emphasize person-ranked orderings on cost/friction* — sort by time/repo by default, and consider keeping "sort by engineer cost" out of team views entirely. A sortable per-person cost column is a leaderboard with extra steps.
- **Watch-item 2: friction score legibility.** Friction is a composite shown per-person in tables, but its formula is explained only in a hover-only tooltip (`FrictionBadge.tsx:84` — `group-hover:block`, keyboard-unreachable). A metric that affects how a person is perceived should have an always-reachable explanation (link to a methodology note), consistent with "talk about the work, not the metric."
- Also worth adding cheaply: a "what my team lead / org can see about me" summary on `/me/settings/privacy` — the toggles exist, but a rendered preview of the effective visibility is the strongest trust signal available.

### G10 — Missing primitives (deliberate scope check)

No dialog/modal, toast, tooltip (non-chart), date-range picker beyond native inputs, or command palette. Most of these absences are defensible minimalism. Two are now blocking other fixes: **dialog** (G3, G5) and **toast/inline-status** (G2). Two are worth a roadmap slot: **command palette** (Cmd+K is the de-facto standard in this product category; with 16 org sections + 10 admin pages and nav-as-data already in `nav-model.ts`, a palette over that model is cheap and high-leverage for the power users this tool serves) and a **custom date-range compare toggle** ("vs previous period" is already computed server-side for stat deltas; exposing the comparison window as a user control is the standard next step).

---

## 4. Prioritized roadmap

**P0 — bugs (small, do now):** B1 fonts (`next/font/google` + the three variables), B2 pagination-drops-filters, B3 audit filter case, B4 false "Saved", B5 dead privacy links, B6 CI-status truncation.

**P1 — quick structural wins (each ≤ a day):**
- `global-error.tsx`, root `not-found.tsx`, section `error.tsx` files (G2)
- `focus-visible` ring in `Button` base; skip link + `main` id; `mark` styling; `aria-current` on session tabs (G3)
- `window.confirm` on the five unconfirmed destructive admin actions (G5)
- `loading.tsx` for `/org`, `/team/[slug]`, `/admin` (G1)
- Collapse the ten `grid-cols-3` stat rows; stack the settings sidebar (G6)
- Label capped lists "top N"; centralize `PAGE_SIZE` (G4, G7)

**P2 — consistency & feedback (the big hygiene PR + follow-ups):**
- Formatter consolidation + timezone policy (G4a) — then codify in `AGENTS.md`
- Empty-state consolidation with standard wording + actions (G4b)
- Server-action result shape + inline errors + success feedback across admin (G2)
- Dialog + toast primitives; retrofit share popover, drawer, destructive confirms (G3, G5)
- Applied-filter chips + zero-result recovery on the two search surfaces (G7)

**P3 — strategic surfaces:**
- Chart keyboard access + per-chart data-table fallback (G3, WCAG 1.4.13/2.1.1)
- Per-section Suspense streaming on the heaviest pages (G1)
- "Waiting for first event" live onboarding loop (G8)
- Table sorting (with the G9 leaderboard guardrail), saved views (G7)
- Command palette over `nav-model.ts`; comparison-period toggle (G10)
- Effective-visibility preview on privacy settings (G9)

---

## 5. Sources

- NN/g: [Complex-application design](https://www.nngroup.com/articles/complex-application-design/), [Progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/), [Dashboards & preattentive attributes](https://www.nngroup.com/articles/dashboards-preattentive/), [Data tables: four user tasks](https://www.nngroup.com/articles/data-tables/), [Empty states](https://www.nngroup.com/articles/empty-state-interface-design/)
- W3C: [Understanding SC 1.4.13 Content on Hover or Focus](https://www.w3.org/WAI/WCAG22/Understanding/content-on-hover-or-focus.html), [SC 1.4.11 Non-text Contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html), [SC 2.5.8 Target Size Minimum](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html), [What's new in WCAG 2.2](https://www.w3.org/WAI/standards-guidelines/wcag/new-in-22/), [Complex images tutorial](https://www.w3.org/WAI/tutorials/images/complex/), [ARIA Authoring Practices](https://www.w3.org/WAI/ARIA/apg/patterns/)
- UK Government Analysis Function: [Charts checklist](https://analysisfunction.civilservice.gov.uk/policy-store/charts-a-checklist/), [Colours in charts](https://analysisfunction.civilservice.gov.uk/policy-store/data-visualisation-colours-in-charts/)
- Carbon Design System: [Dashboards](https://v11.carbondesignsystem.com/data-visualization/dashboards/), [Dataviz color palettes](https://carbondesignsystem.com/data-visualization/color-palettes/), [Empty states pattern](https://carbondesignsystem.com/patterns/empty-states-pattern/)
- Filtering/tables: [Pencil & Paper — enterprise filtering](https://www.pencilandpaper.io/articles/ux-pattern-analysis-enterprise-filtering), [enterprise data tables](https://www.pencilandpaper.io/articles/ux-pattern-analysis-enterprise-data-tables), [GOV.UK table component](https://design-system.service.gov.uk/components/table/)
- Performance: [Next.js streaming](https://nextjs.org/learn/dashboard-app/streaming), [web.dev CLS](https://web.dev/articles/optimize-cls), [web.dev stale-while-revalidate](https://web.dev/articles/stale-while-revalidate)
- Metrics ethics: [The SPACE of Developer Productivity (ACM Queue)](https://dl.acm.org/doi/pdf/10.1145/3454122.3454124), [Swarmia — Don't stack rank your developers](https://www.swarmia.com/blog/dont-stack-rank-your-developers/), [Swarmia — healthy developer productivity](https://www.swarmia.com/developer-productivity/)
- First-run: [Datadog agentic onboarding](https://docs.datadoghq.com/agentic_onboarding/setup/), [Superhuman — command palette](https://blog.superhuman.com/how-to-build-a-remarkable-command-palette/), [uxpatterns.dev — date range](https://uxpatterns.dev/patterns/forms/date-range)
