# apps/web — agent notes

Read [`/PLAN.md`](../../PLAN.md) and [`/tasks/`](../../tasks/) before picking up work in this app.

## Conventions

- **Next.js 16, App Router, Turbopack default** (no `--turbo` flag needed).
- **React 19.2** with Server Components by default. Client components only when interactive — mark them with `'use client'` and keep them small.
- **Tailwind CSS 4** with CSS-first config. The theme lives in `src/styles/globals.css` under `@theme { … }`. **Do not create `tailwind.config.ts`.**
- **Auth is owned by `@ai-agents-observability/auth`** — do not introduce NextAuth. Use `currentUser()` from `src/lib/auth.ts` in server components / route handlers.
- **Prisma**: server-only. Import `prisma` from `src/lib/prisma.ts`; never reference it inside `'use client'` modules.
- **Routing layout**:
  - `/login`, `/install`, `/health`, `/metrics` — public.
  - `/me/*` — authenticated, own-data scope. Session list, PR list, insights, search, transcript viewer, privacy settings, audit feed.
  - `/team/[slug]/*` — authenticated, team-scoped. Roster, member sessions, PR tab. Gated by `team_lead` role via `requireTeamAccess()`.
  - `/org/*` — authenticated, org-scoped. Dashboard, adoption funnel, benchmarks, delivery stats, tools breakdown, search, cross-user session/transcript. Gated by `org_admin` or `viewer_aggregate` roles.
  - `/admin/*` — authenticated, `org_admin` only. Alerts, access grants, adapters, jobs, org roles, team roles, price tables, retention.
  - `/api/auth/*` — OAuth + session endpoints; device-code flow for the hook binary.
  - `/api/me/*` — transcript proxy, data export, self-deletion.
  - `/api/org/*` and `/api/team/[slug]/*` — cross-user transcript endpoints (audit-logged).

## Pinning

Every dep is pinned via the root `package.json` catalog. Sub-packages reference shared deps as `"catalog:"`. Don't add a new dep without adding it to the catalog first — see [`/PLAN.md`](../../PLAN.md) §4 "Pinning policy".
