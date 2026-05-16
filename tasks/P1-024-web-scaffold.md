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

A Next.js app exists at `apps/web` with the App Router, Prisma client wired, auth cookies parsed into a `currentUser()` helper, a global layout, and `/login` + `/me` placeholder pages.

## Context

- `DESIGN_DOC.md` §6.5 — only show what the user is allowed to see; every read is scoped to `currentUser()`.
- App Router with React Server Components is the default. No client state libraries by default — only add if forced.

## Acceptance criteria

- [ ] `apps/web` is a Next.js 15 app with App Router, TypeScript, Tailwind CSS.
- [ ] `src/lib/auth.ts` exports `currentUser()` (server-side): reads the access-token cookie, verifies via `@pkg/auth`, returns the `User` row from Prisma or `null`.
- [ ] Middleware redirects unauthenticated requests for `/me/*` to `/login`.
- [ ] `/login` page: branding, "Sign in with GitHub" button → `/api/auth/login`. Reads `GITHUB_HOST` and shows it ("Signing in via github.acme.example").
- [ ] `/me` placeholder page: shows `Hello, ${user.display_name}` from `currentUser()`. Confirms auth flow end-to-end.
- [ ] Global layout: top nav (logo, user menu with logout), main content area, footer with privacy link.
- [ ] Dark mode default with light option (Tailwind class strategy).
- [ ] `apps/web/Dockerfile` + override entry in `infra/docker-compose.override.yml`.
- [ ] Test: rendered `/login` returns 200; `/me` while signed out returns redirect; while signed in returns 200 with display name.

## Implementation notes

- Server components throughout for `/me/*`; client components only for interactive widgets (logout button).
- Don't introduce NextAuth — we own auth in `@pkg/auth`. NextAuth's abstractions don't fit the SSO seam.
- Use `next/font` for typography; no runtime font fetches.

## Files touched

- `apps/web/package.json`, `next.config.mjs`, `tailwind.config.ts`, `postcss.config.cjs`
- `apps/web/src/app/layout.tsx`, `loading.tsx`, `error.tsx`
- `apps/web/src/app/login/page.tsx`
- `apps/web/src/app/me/page.tsx` (placeholder)
- `apps/web/src/middleware.ts`
- `apps/web/src/lib/auth.ts`, `prisma.ts`
- `apps/web/src/components/{Nav,UserMenu,Footer}.tsx`
- `apps/web/Dockerfile`
- `apps/web/test/auth.test.ts`

## Out of scope

- Real `/me` content (P1-025).
- Sessions list (P1-026).
- Privacy/audit pages (P1-027).

## Verification

```bash
pnpm --filter=@app/web dev
# Visit http://localhost:3000/login, click sign-in, verify redirect to /me with the display name.
pnpm --filter=@app/web test
```
