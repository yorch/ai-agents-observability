# apps/web — agent notes

Read [`/PLAN.md`](../../PLAN.md) and [`/tasks/`](../../tasks/) before picking up work in this app.

## Conventions

- **Next.js 16, App Router, Turbopack default** (no `--turbo` flag needed).
- **React 19.2** with Server Components by default. Client components only when interactive — mark them with `'use client'` and keep them small.
- **Tailwind CSS 4** with CSS-first config. The theme lives in `src/styles/globals.css` under `@theme { … }`. **Do not create `tailwind.config.ts`.**
- **Auth is owned by `@ai-agents-observability/auth`** — do not introduce NextAuth. Use `currentUser()` from `src/lib/auth.ts` in server components / route handlers.
- **Prisma**: server-only. Import `prisma` from `src/lib/prisma.ts`; never reference it inside `'use client'` modules.
- **Routing layout**:
  - `/login` — public.
  - `/me/*` — authenticated. Gated by `src/middleware.ts` (cookie presence) and verified per-request by `currentUser()`.
  - `/api/auth/*` — OAuth + session endpoints (P1-016, P1-017).

## Pinning

Every dep is pinned via the root `package.json` catalog. Sub-packages reference shared deps as `"catalog:"`. Don't add a new dep without adding it to the catalog first — see [`/PLAN.md`](../../PLAN.md) §4 "Pinning policy".
