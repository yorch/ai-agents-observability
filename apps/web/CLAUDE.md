# apps/web — agent notes

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
- **Build from `src/components/ui`.** `Card`, `Stat`, `Table`/`Row`/`Cell`, `Badge`/`SeriesBadge`, `Button`/`ButtonLink`, `Input`/`Select`/`Textarea`/`Field`, `Segmented`, `Pagination`, `PageHeader`, `SectionHeader`, `EmptyState`, `SkeletonCard`/`SkeletonBar`, and the chart set (`BarChart`, `HBars`, `AreaLine`, `ShareBar`, `Sparkline`, `Legend`, `ChartHover`, `scale`). Reach for these rather than hand-rolling a card, button, control or table.
  - `Card` takes `title`/`caption`/`hint` — don't hand-write the heading inside it. `className` styles the card; **content spacing goes on `contentClassName`**, because `space-y-*` acts on siblings and the card's own child is a single wrapper.
  - Import from `@/components/ui/<Name>` rather than the barrel inside `'use client'` files: the barrel pulls `Table` and every chart module into that client graph.
  - **Every table is on the primitive** — there are no raw `<table>`s left. `Column.label` is a string, so an interpolated header is fine; `Cell` takes `colSpan` for spacer and empty-state rows.
  - `Card` takes `flush` for content that supplies its own inset — a `divide-y` list, or a table that should meet the card's border.
  - **Eleven elements still carry the card surface by hand, all deliberately.** Grepping the class string over-counts, so the breakdown matters more than the number: two `<form method="GET">` and one clickable `<Link>` (`Card` renders a `div`, so it cannot be either); two popovers, which are positioned absolutely and are not cards; and six intentionally denser rows (`px-4 py-3`, `p-3`) plus the rail's segment wrapper. Leave them unless you are changing what they are.
  - **Control size is scale; width is layout.** `md` and `sm` set padding and type size only, and each matches the same `Button` size in height — a control and its submit button line up in a filter row with no nudging. `Field` makes its own control full-width; anywhere else say so at the call site (`className="w-full"`, `"flex-1"`). No third padding step: a control that fits neither size is a sign the layout is wrong, not the scale. There are no raw `<select>` or `<textarea>` left; **seven narrow numeric/search `<input>`s still hand-roll a control** (`px-2 py-1`, `w-20`…`w-32`) in `admin/alerts`, `admin/access-grants`, `admin/retention`, `me/SessionPRLinks` and `me/TranscriptViewer`. They need a width at the call site and `sm`, not a new size.
  - **`Field` is the stacked-label form layout** — label, control, optional hint. Use it instead of hand-rolling `<div className="space-y-1"><label …>`; it also supplies the control's width. A filter row of one or two controls can put `Field`s straight into a `flex … items-end` row; past that, use a `grid` (see `/org/search`, `/me/sessions`).
- **Charts stay Server Components.** Emit markup with `data-tip="label|value"` on each mark and wrap it in `ChartHover`; that is the only client code a chart needs. Colour follows the entity, never its rank — a filter must not repaint the survivors. Two or more series always get a `Legend`.
- **Navigation is data, not markup.** The rail (`src/components/shell/`) is the only nav surface; add a section to `nav-model.ts` rather than building another bar. Section layouts are pass-throughs — the root layout owns the single content measure.
- **Icons, not emoji.** Never use emoji or Unicode symbol glyphs (✓ ⚠ ▶ ▲ ▼ ← → ↑ ↓ ↗ 👍 🎉 …) as UI affordances. Import a component from [`src/components/icons`](src/components/icons/index.tsx) instead — stroke-based SVGs on a 16×16 grid that inherit color via `currentColor`. Add new icons to that module rather than reaching for an icon library (none is installed). Typographic characters used as *units* rather than icons — the multiplication sign `×` ("3×"), the en-dash `–`, or a prose "maps to" arrow — stay as text.
- **Auth is owned by `@ai-agents-observability/auth`** — do not introduce NextAuth. Use `currentUser()` from `src/lib/auth.ts` in server components / route handlers.
- **Prisma**: server-only. Import `prisma` from `src/lib/prisma.ts`; never reference it inside `'use client'` modules.
- **Routing layout**:
  - `/login`, `/install`, `/health`, `/metrics` — public.
  - `/me/*` — authenticated, own-data scope. Session list, PR list, insights, search, transcript viewer, privacy settings, audit feed.
  - `/team/[slug]/*` — authenticated, team-scoped. Roster, member sessions, PR tab. Gated by `team_lead` role via `requireTeamAccess()`.
  - `/org/*` — authenticated, org-scoped. Dashboard (incl. spend forecast + cohort friction), adoption funnel, benchmarks, delivery stats, tools breakdown, models (routing recommendations), ROI, quality, security (data-flow/secret exposure), knowledge (topic clustering), governance, search, cross-user session/transcript. Gated by `org_admin` or `viewer_aggregate` roles.
  - `/admin/*` — authenticated, `org_admin` only. Alerts, access grants, adapters, jobs, org roles, team roles, price tables, retention.
  - `/api/auth/*` — OAuth + session endpoints; device-code flow for the hook binary.
  - `/api/me/*` — transcript proxy, data export, self-deletion.
  - `/api/org/*` and `/api/team/[slug]/*` — cross-user transcript endpoints (audit-logged).

## Pinning

Every dep is pinned via the root `package.json` catalog. Sub-packages reference shared deps as `"catalog:"`. Don't add a new dep without adding it to the catalog first — see [`/PLAN.md`](../../PLAN.md) §4 "Pinning policy".
