---
id: P1-024
title: Next.js scaffold + OAuth wiring
phase: 1
workstream: E
status: blocked
owner: null
depends_on: [P1-001, P1-016]
blocks: [P1-025, P1-026, P1-027]
estimate: M
---

## Goal

A Next.js 16 app exists at `apps/web` with the App Router, Turbopack as the default builder, React 19.2 RSC patterns, Tailwind CSS 4 (CSS-first config), Prisma 7 client wired, auth cookies parsed into a `currentUser()` helper, a global layout, and `/login` + `/me` placeholder pages.

## Context

- `DESIGN_DOC.md` §6.5 — only show what the user is allowed to see; every read is scoped to `currentUser()`.
- App Router with React Server Components is the default. No client state libraries by default — only add if forced.
- **Next.js 16**: Turbopack is default for `dev` AND `build`. Pins React 19.2.x. Scaffold ships `AGENTS.md`/`CLAUDE.md` — keep those, edit to point at this repo's `PLAN.md` + `tasks/`.
- **Tailwind 4**: no `tailwind.config.js`. Theme lives in CSS via `@theme { ... }`. Plugin is `@tailwindcss/postcss` (or `@tailwindcss/vite` — but with Next 16 + Turbopack we use the dedicated `@tailwindcss/postcss` plugin OR Next's built-in support).

## Acceptance criteria

- [ ] `apps/web` is a Next.js 16.2.x app with App Router, TypeScript 6, Tailwind CSS 4.1.x, React 19.2.x.
- [ ] `next dev` and `next build` both run on Turbopack (the default in Next 16; no flag needed).
- [ ] `apps/web/src/styles/globals.css` declares the Tailwind theme inline: `@import "tailwindcss"; @theme { --color-brand-*: ...; --font-display: ...; }`. **No `tailwind.config.ts`.**
- [ ] Biome config (root `biome.json`) has `linter.rules.nursery.useSortedClasses` enabled with the Tailwind 4 preset so class strings stay sorted.
- [ ] `src/lib/auth.ts` exports `currentUser()` (server-side): reads the access-token cookie, verifies via `@pkg/auth` (jose 6 / Ed25519), returns the `User` row from Prisma or `null`.
- [ ] Middleware (`src/middleware.ts`) redirects unauthenticated requests for `/me/*` to `/login`. Uses Next 16's stable middleware API.
- [ ] `/login` page: branding, "Sign in with GitHub" button → `/api/auth/login`. Reads `GITHUB_HOST` and shows it ("Signing in via github.acme.example").
- [ ] `/me` placeholder page: shows `Hello, ${user.display_name}` from `currentUser()`. Confirms auth flow end-to-end.
- [ ] Global layout: top nav (logo, user menu with logout), main content area, footer with privacy link.
- [ ] Dark mode default with light option (Tailwind 4 `prefers-color-scheme` via `@variant dark` in CSS, no `class` strategy unless needed for the toggle).
- [ ] `apps/web/Dockerfile` (Node 24 base) + override entry in `infra/docker-compose.override.yml`.
- [ ] Scaffold's `AGENTS.md` / `CLAUDE.md` edited to reference `/PLAN.md` and `/tasks/` so any agent landing in the app folder reads the working contract.
- [ ] Test: rendered `/login` returns 200; `/me` while signed out returns redirect; while signed in returns 200 with display name.

## Implementation notes

- Server components throughout for `/me/*`; client components only for interactive widgets (logout button, future filters).
- Don't introduce NextAuth — we own auth in `@pkg/auth`. NextAuth's abstractions don't fit the SSO seam.
- Use `next/font` for typography; no runtime font fetches.
- For Prisma in Next 16: import the singleton from `@pkg/db`; use it ONLY inside server components / route handlers / server actions. Never in client components.
- Watch for the React 19.2 RSC CVE patched in Dec 2025 — make sure your React patch is ≥ 19.2.6.
- Turbopack-specific gotcha: some webpack-only plugins won't work. We don't pull any in, but if a contributor adds one, fail the build loudly.

## Files touched

- `apps/web/package.json`, `next.config.ts`, `postcss.config.mjs`
- `apps/web/src/app/layout.tsx`, `loading.tsx`, `error.tsx`
- `apps/web/src/styles/globals.css` (Tailwind 4 `@theme` block)
- `apps/web/src/app/login/page.tsx`
- `apps/web/src/app/me/page.tsx` (placeholder)
- `apps/web/src/middleware.ts`
- `apps/web/src/lib/auth.ts`, `prisma.ts`
- `apps/web/src/components/{Nav,UserMenu,Footer}.tsx`
- `apps/web/AGENTS.md`, `apps/web/CLAUDE.md` (edited from scaffold)
- `apps/web/Dockerfile`
- `apps/web/test/auth.test.ts`

## Out of scope

- Real `/me` content (P1-025).
- Sessions list (P1-026).
- Privacy/audit pages (P1-027).

## Verification

```bash
bun --filter '@app/web' dev
# Visit http://localhost:3000/login, click sign-in, verify redirect to /me with the display name.
bun --filter '@app/web' build      # Turbopack production build
bun --filter '@app/web' test
```
