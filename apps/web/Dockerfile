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
# Dummy values — next build never connects to DB or auth service.
ARG DATABASE_URL=postgresql://x:x@placeholder:5432/x
ARG BETTER_AUTH_SECRET=build-time-placeholder
ENV DATABASE_URL=$DATABASE_URL BETTER_AUTH_SECRET=$BETTER_AUTH_SECRET
RUN cd packages/db && PRISMA_SCHEMA_ENGINE_BINARY=$(pwd)/scripts/prisma-schema-engine-stub.sh bunx prisma generate
RUN cd apps/web && bunx next build

# ── Production ────────────────────────────────────────────────────────────────
FROM node:24-alpine AS production
WORKDIR /app

ARG APP_VERSION=dev
ARG COMMIT_HASH=unknown
ARG BUILD_TIME=unknown
ARG GIT_BRANCH=unknown
ARG GIT_TAG=
ARG GIT_TIMESTAMP=unknown
ARG BUILD_NUMBER=0
ENV APP_VERSION=${APP_VERSION} \
    COMMIT_HASH=${COMMIT_HASH} \
    BUILD_TIME=${BUILD_TIME} \
    GIT_BRANCH=${GIT_BRANCH} \
    GIT_TAG=${GIT_TAG} \
    GIT_TIMESTAMP=${GIT_TIMESTAMP} \
    BUILD_NUMBER=${BUILD_NUMBER}

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Standalone bundle includes only the traced runtime files; static assets
# are served from the sibling .next/static directory.
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "require('http').get('http://127.0.0.1:3000/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"]

CMD ["node", "apps/web/server.js"]
