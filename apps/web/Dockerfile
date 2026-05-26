# syntax=docker/dockerfile:1.24
# Next.js production runtime is Node 24 (Next-on-Bun is unofficial — see PLAN.md §4).
# We still use Bun for package management to stay aligned with the rest of the monorepo.

# ── Base ──────────────────────────────────────────────────────────────────────
FROM oven/bun:1.3.14-alpine AS base
WORKDIR /app

# ── Dependencies ──────────────────────────────────────────────────────────────
FROM base AS deps
COPY bun.lock package.json bunfig.toml ./
COPY apps/github-app/package.json apps/github-app/
COPY apps/hook/package.json apps/hook/
COPY apps/ingest/package.json apps/ingest/
COPY apps/web/package.json apps/web/
COPY packages/auth/package.json packages/auth/
COPY packages/db/package.json packages/db/
COPY packages/github/package.json packages/github/
COPY packages/redaction/package.json packages/redaction/
COPY packages/schemas/package.json packages/schemas/
RUN bun install --frozen-lockfile

# ── Build ─────────────────────────────────────────────────────────────────────
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/ packages/
COPY apps/web/ apps/web/
RUN cd packages/db && bunx prisma generate
RUN cd apps/web && bunx next build

# ── Production ────────────────────────────────────────────────────────────────
FROM node:24-alpine AS production
WORKDIR /app

RUN addgroup -S web && adduser -S web -G web
USER web

ENV NODE_ENV=production
ENV PORT=3000

COPY --from=build --chown=web:web /app/apps/web/.next ./apps/web/.next
COPY --from=build --chown=web:web /app/apps/web/package.json ./apps/web/
COPY --from=build --chown=web:web /app/apps/web/next.config.ts ./apps/web/
COPY --from=build --chown=web:web /app/packages/db/src/generated ./packages/db/src/generated
COPY --from=deps --chown=web:web /app/node_modules ./node_modules

WORKDIR /app/apps/web
EXPOSE 3000
CMD ["npx", "next", "start"]
