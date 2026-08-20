# apps/web — agent notes

> `CLAUDE.md` here is a symlink to this file. Edit `AGENTS.md`.
>
> **Root rules still apply.** Claude Code concatenates this file with the repo-root
> [`AGENTS.md`](../../AGENTS.md); some other agents load only the *nearest* file.
> The invariants most expensive to lose are restated here for that case:
> four gates before every commit (`bun run check` → `typecheck` → `build` → `test`);
> `packages/schemas` is the only source of telemetry event shapes; and auth is
> `@ai-agents-observability/auth` — **never NextAuth**.

Read [`/PLAN.md`](../../PLAN.md) and [`/tasks/`](../../tasks/) before picking up work in this app.

## Conventions

> The direction these conventions come from — and the audit that motivated it — is
> [`docs/design/ui-direction.html`](../../docs/design/ui-direction.html). That page is a
> point-in-time pitch; this file is the living source of truth.

- **Next.js 16, App Router, Turbopack default** (no `--turbo` flag needed).
- **React 19.2** with Server Components by default. Client components only when interactive — mark them with `'use client'` and keep them small.
- **Tailwind CSS 4** with CSS-first config. The theme lives in `src/styles/globals.css` under `@theme { … }`. **Do not create `tailwind.config.ts`.**
- **Semantic tokens only — never raw palette utilities.** `bg-white/5`, `text-red-400`, `border-yellow-500/40` and friends are dark-only by construction and silently break the light theme; there are zero left in the app and none should come back. Use:
  - surfaces `bg-bg` · `bg-surface` · `bg-surface-2` · `bg-surface-3`
  - lines `border-border-subtle` · `border-border` · `border-border-strong`
  - ink `text-text` · `text-text-2` · `text-text-3` (all three clear WCAG AA against both the ground and the card surface, in both themes)
  - signature `text-accent` · `bg-accent` (carries `text-bg`), then four emphasis roles rather than ad hoc alphas: `bg-accent-muted` (data fills), `bg-accent-soft` (chips), `bg-accent-dim` (row wash), `border-accent-line`
  - status `{text,bg,border}-{good,warn,crit}[-soft|-line]` — reserved for state, never for a chart series
  - series `series-1 … series-6` — charts and categorical sets, assigned by entity in fixed order, folded into "Other" past six (`foldToSeries`)
  - domain `merged` — the PR "merged" purple, which must not move when the series palette is re-tuned
- **Both themes are supported.** Anything you add must read correctly in light and dark. The tokens handle this for you as long as you use them.
- **Build class strings with `cx()`** (`src/components/ui/cx.ts`), never by interpolating into a template literal. A class that abuts the opening `${` is not extracted by Tailwind's scanner, so the utility silently vanishes from the built CSS — and it fails *invisibly* whenever that utility also appears elsewhere, which is why it went unnoticed until a one-off arbitrary variant hit it. (Tailwind also scans this file, so a class name written here becomes a real rule; keep them out of prose.)
- **Build from `src/components/ui`.** `Card`, `Stat`, `Table`/`Row`/`Cell`, `Badge`/`SeriesBadge`, `Button`/`ButtonLink`, `Input`/`Select`/`Textarea`/`Field`, `FilterPanel`, `Segmented`, `Pagination`, `PageHeader`, `SectionHeader`, `EmptyState`, `SkeletonCard`/`SkeletonBar`, `cx`, and the chart set (`BarChart`, `HBars`, `AreaLine`, `ShareBar`, `Sparkline`, `Legend`, `ChartHover`, `scale`). Reach for these rather than hand-rolling a card, button, control or table.
  - `Card` takes `title`/`caption`/`hint` — don't hand-write the heading inside it. `className` styles the card; **content spacing goes on `contentClassName`**, because `space-y-*` acts on siblings and the card's own child is a single wrapper.
  - Import from `@/components/ui/<Name>` rather than the barrel inside `'use client'` files: the barrel pulls `Table` and every chart module into that client graph.
  - **Every table is on the primitive** — there are no raw `<table>`s left. `Column.label` is a string, so an interpolated header is fine; `Cell` takes `colSpan` for spacer and empty-state rows.
  - `Card` takes `flush` for content that supplies its own inset — a `divide-y` list, or a table that should meet the card's border.
  - **Faceted filter forms use `FilterPanel`** — the card surface as a `<form method="GET">`, which `Card` cannot be because it renders a `div`. Fields go in a `grid`, actions in a bordered footer row.
  - **Some elements still carry the card surface by hand, all deliberately** — a clickable `<Link>`; popovers, which are absolutely positioned and are not cards; and intentionally denser rows (`px-4 py-3`, `p-3`) plus the rail's segment wrapper. Leave them unless you are changing what they are. **Don't restate this as a count** — grepping the class string over-counts, and every number written here has gone stale within a PR.
  - **Control size is scale; width is layout.** `md` and `sm` set padding and type size only, and each matches the same `Button` size in height — a control and its submit button line up in a filter row with no nudging. `Field` makes its own control full-width; anywhere else say so at the call site (`className="w-full"`, `"flex-1"`). No third padding step: a control that fits neither size is a sign the layout is wrong, not the scale. Measured, every control and button is **30px at `sm` and 38px at `md`** — the one exception is `<select>` at `md`, which Chromium renders at 36; don't patch that 2px inline. No raw `<select>`, text `<input>` or `<textarea>` is left outside `Field.tsx`. What remains raw is not a sized control: `<input type="hidden">` form plumbing, one checkbox, and the command palette's borderless combobox input (part of the dialog chrome, not a form field) — none has a padding scale.
  - **`Field` is the stacked-label form layout** — label, control, optional hint. Use it instead of hand-rolling `<div className="space-y-1"><label …>`; it also supplies the control's width, and its own `className` is where a narrow numeric field says `w-24`. A filter row of one or two controls can put `Field`s straight into a `flex … items-end` row; past that, use a `grid` (see `/org/search`, `/me/sessions`).
  - **The raw `<button>`s that remain should stay** — a toggle switch, the theme and sign-out icons, the rail drawer, popover triggers, copy/revoke/remove text affordances and the feedback pair. They are not `Button` variants. Don't add a variant for a single consumer (that is why `ghost` was removed, and why the bulk-approve accent outline became `secondary`). A `next/link` that must read as a button takes `buttonClasses(variant, size)` rather than `ButtonLink`, which renders a plain `<a>` and would lose client-side navigation.
- **Charts stay Server Components.** Emit markup with `data-tip="label|value"` on each mark and wrap it in `ChartHover`; that is the only client code a chart needs. Colour follows the entity, never its rank — a filter must not repaint the survivors. Two or more series always get a `Legend`.
- **Route error/loading files are one-line re-exports.** `error.tsx` re-exports `SectionError` and `loading.tsx` re-exports `SectionLoading` (`src/components/`); don't paste a bespoke boundary per segment — the four copies this replaced had already drifted.
- **Navigation is data, not markup.** The rail (`src/components/shell/`) is the only nav surface; add a section to `nav-model.ts` rather than building another bar. Section layouts are pass-throughs — the root layout owns the single content measure.
- **Icons, not emoji.** Never use emoji or Unicode symbol glyphs (✓ ⚠ ▶ ▲ ▼ ← → ↑ ↓ ↗ 👍 🎉 …) as UI affordances. Import a component from [`src/components/icons`](src/components/icons/index.tsx) instead — stroke-based SVGs on a 16×16 grid that inherit color via `currentColor`. Add new icons to that module rather than reaching for an icon library (none is installed). Typographic characters used as *units* rather than icons — the multiplication sign `×` ("3×"), the en-dash `–`, or a prose "maps to" arrow — stay as text.
- **Formatting goes through `src/lib/fmt.ts` — never a local re-implementation.** `fmtUsd` (aggregates, 2dp) vs `fmtUsdSession` (per-session/per-event, 3dp — the same quantity must not change shape between list and detail); `fmtDuration`/`fmtDurationOrDash` take **milliseconds**, `fmtDurationSec` takes **seconds**; `fmtDate`/`fmtDateTime`/`fmtDayShort` (chart axis labels) are pinned to en-US + UTC on module-level cached `Intl.DateTimeFormat`s (a bare `toLocaleString` renders in the server's zone on SSR and the browser's after hydration, and rebuilds a formatter per call). Where a timestamp's zone matters (admin, audit), append the literal ` UTC`. Numbers keep `toLocaleString()` for thousands separators. `fmtPct`/`fmtPctOrDash` take an optional digit count that defaults to 0 — pass 1 for a quantity that lives near zero, since an error rate of 0.004 renders as "0%" at 0dp and reads as "none" rather than "rare".
- **Empty states have two shapes.** Section-level: the `EmptyState` primitive (`title` + guidance + `action` — filtered views offer "Clear filters", first-run views offer the install/setup CTA). Inside a `Card`: the `CardEmpty` primitive, never a nested EmptyState card. Wording: `No <thing> recorded yet.` for first-run (keep any how-data-arrives explanation), `No <thing> in this period.` for windowed views. A component must never render nothing (or a headers-only table) for an empty result.
- **Form server actions return `ActionResult`** (`src/lib/action-result.ts`) — success `{ ok, message? }`, rejection `{ ok: false, error }` naming what was wrong. Wrap every action in `withActionResult` so an unexpected throw becomes an inline error instead of the error boundary; render through `ActionForm` (`useActionState` under the hood), or the `useActionResult` hook for client components that submit programmatically. A bare `return;` on invalid input is a bug, not a guard. Destructive one-click submits go through `ConfirmButton` (or `confirmSubmit` for text affordances). Row-mutating writes use `updateMany`/`deleteMany` + count check and report "not found — refresh and try again" on 0 rows.
- **Keyboard access is part of done.** `globals.css` paints `:focus-visible` for link/button-like elements; anything with `role="dialog"` uses `useFocusTrap(ref, open, onClose)` — it owns focus-in, Tab cycling over *visible* focusables, Escape-to-close (stopping propagation so stacked layers close one at a time), and focus restore (skipped when a click-outside moved focus elsewhere); never add a separate document-level Escape listener per dialog; chart marks carrying `data-tip` are focusable with an `aria-label` that repeats the tooltip value (`ChartHover` raises tips on focus and dismisses on Escape). Data that exists only in a `title` attribute or a hover tooltip is a bug.
- **Faceted pages keep filter state visible and survivable.** Applied filters render as `FilterChips` (per-chip remove + clear-all); every pager `hrefFor` must carry the active filters (dropping them on page 2 was a shipped bug); zero-result states say the filters caused it and offer one-click clear.
- **The command palette derives from `nav-model.ts`** — add a page to the nav model and Cmd/Ctrl+K finds it; never give the palette its own page list.
- **Auth is owned by `@ai-agents-observability/auth`** — do not introduce NextAuth. Use `currentUser()` from `src/lib/auth.ts` in server components / route handlers.
- **Prisma**: server-only. Call `getPrisma()` from `src/lib/prisma.ts` — there is no bare `prisma` export to import, deliberately, because the guarded and unguarded clients have to be told apart at the call site (see the `run_kind` section below). Never reference either inside `'use client'` modules.
- **Routing layout**:
  - `/login`, `/install`, `/health`, `/metrics` — public.
  - `/me/*` — authenticated, own-data scope. Session list + detail + transcript viewer, PR list, insights, search, access grants, and settings (profile, privacy, audit feed).
  - `/team/[slug]/*` — authenticated, team-scoped. Roster, sessions, member drill-down (sessions + transcript), PRs, adoption, agents, tools, skills, MCP. Gated by `team_lead` role via `requireTeamAccess()`.
  - `/org/*` — authenticated, org-scoped. Dashboard (incl. spend forecast + cohort friction), adoption funnel, benchmarks, delivery stats, agents comparison, tools breakdown, skills and MCP effectiveness, models (routing recommendations), ROI, quality, security (data-flow/secret exposure), knowledge (topic clustering), governance, teams, search, cross-user session/transcript. Gated by `org_admin` or `viewer_aggregate` roles.
  - `/admin/*` — authenticated, `org_admin` only. Alerts, access grants, adapters, jobs, org roles, team roles, price tables, retention.
  - `/api/auth/*` — OAuth + session endpoints; device-code flow for the hook binary.
  - `/api/me/*` — transcript proxy, data export, self-deletion.
  - `/api/org/*` and `/api/team/[slug]/*` — cross-user transcript endpoints (audit-logged).

## The `run_kind` guard lives in the data layer, not at call sites

Sessions and events carry a `run_kind` (`INTERACTIVE` | `CI` | `EVAL`). CI and eval
runs have no human prompts, so they are stored and trendable but must never enter a
number a dashboard presents as developer behaviour.

**You do not write the filter.** Two mechanisms apply it for you:

- **Raw SQL** reads the filtered views `interactive_sessions` / `interactive_events`
  (defined in `packages/db/sql/migrations/0001_init.sql`) instead of the base tables.
- **Prisma ORM** reads go through `getPrisma()`, whose client is extended to inject
  `runKind: 'INTERACTIVE'` into every `session` read (`withInteractiveOnly` in
  `packages/db`). An explicit `runKind` in your `where` still wins, so a future
  CI-facing surface needs no escape hatch.

A read that legitimately sees every run **opts out explicitly**: name the base table
in SQL, or call `getAllRunsPrisma(reason)`. The `reason` string is never used at
runtime — it exists so the exemption is argued at the call site and visible in a
diff. Pair either with a `run-kind-exempt: <why>` comment; `test/run-kind-coverage.test.ts`
fails without one.

Three kinds of read qualify, and only these three: per-session drill-downs (a page
scoped to one id is not a population — filtering it renders empty tabs rather than
excluding anything), facet counts over a person's own data, and fleet inventory
(which agents are reporting at all) where a CI-only runner must still be counted.

**Why this shape.** The rule used to be a fragment you remembered at ~140 call sites,
policed by a counting lint. That failed four times in a row, each round finding sites
the previous mechanism could not see: the predicate drifted inline and let CI runs
into org spend (`getOrgSummary` read 121 sessions / $547.83 against a true 115 /
$19.03); centralizing it revealed 18 SQL and 22 ORM sites that had never adopted it;
counting per literal then caught seven guards bound to a CTE while the driving query
ran unfiltered; and the ingest alert engine still had two unguarded `events` reads.
Counting can prove a filter is *present* and never that it is bound to the right scan.

The inversion is chosen for the shape of its failures. A forgotten guard used to
produce an inflated aggregate — silent, plausible, wrong. A forgotten opt-out now
produces an empty drill-down page — loud, immediate, attributable.

One trap worth knowing, because it defeated the guard completely and silently:
`packages/db` publishes a module-level client on `globalThis._prisma` outside
production. `src/lib/prisma.ts` therefore caches under `_prismaGuarded`, not
`_prisma` — sharing the key meant importing the db package pre-populated the cache
with an **unguarded** client, and `getPrisma()` handed it straight back. A test pins
this.

## Pinning

Every dep is pinned via the root `package.json` catalog. Sub-packages reference shared deps as `"catalog:"`. Don't add a new dep without adding it to the catalog first — see [`/PLAN.md`](../../PLAN.md) §4 "Pinning policy".
