# syntax=docker/dockerfile:1.24

# ── Base ──────────────────────────────────────────────────────────────────────
FROM oven/bun:1.3.14-alpine AS base
WORKDIR /app
# keytar (transitive native dep via packages/auth) compiles via node-gyp during
# `bun install`; provide its build toolchain. This lives in the build-only deps
# stage and never reaches the production stage. keytar is loaded lazily with a
# try/catch fallback, so the runtime image needs no libsecret.
RUN apk add --no-cache build-base python3 libsecret-dev

# ── Dependencies ──────────────────────────────────────────────────────────────
FROM base AS deps
COPY bun.lock package.json bunfig.toml ./
COPY apps/github-app/package.json apps/github-app/
COPY apps/hook/package.json apps/hook/
COPY apps/ingest/package.json apps/ingest/
COPY apps/site/package.json apps/site/
COPY apps/web/package.json apps/web/
COPY packages/auth/package.json packages/auth/
COPY packages/db/package.json packages/db/
COPY packages/github/package.json packages/github/
COPY packages/redaction/package.json packages/redaction/
COPY packages/schemas/package.json packages/schemas/
# The root `postinstall` runs `prisma generate`, so the schema must be present
# before install. Copying it here (rather than skipping scripts) keeps native
# dependency builds — notably keytar via node-gyp — working.
COPY packages/db/prisma.config.ts packages/db/
COPY packages/db/prisma packages/db/prisma
RUN bun install --frozen-lockfile

# Generate Prisma client — cd to packages/db so prisma.config.ts is picked up
RUN cd packages/db && bunx prisma generate

# ── Production ────────────────────────────────────────────────────────────────
FROM oven/bun:1.3.14-alpine AS production
WORKDIR /app

RUN apk add --no-cache postgresql-client
RUN addgroup -g 1001 -S runner && adduser -S runner -u 1001 -G runner

# Copy the full node_modules from the deps stage. The migrations runner invokes
# the Prisma CLI (`bunx prisma migrate deploy`) which has a deep transitive
# dependency tree (c12 → chokidar/giget/ohash, @prisma/dev → foreground-child/
# std-env, proper-lockfile → signal-exit, etc.) that is impractical to
# cherry-pick safely. This one-shot container exits in seconds, so the size
# trade-off is acceptable. The win over the original single-stage image is that
# the build toolchain (build-base, python3, libsecret-dev) stays in the deps
# stage and never reaches this layer, and --chown on COPY avoids the 1.17 GB
# chown -R layer the original had.
COPY --from=deps --chown=runner:runner /app/node_modules ./node_modules

# Source — schema, migrations, SQL, and the db package's source (run.ts imports
# from @ai-agents-observability/db which resolves to packages/db/src/index.ts).
# The prisma schema and config come from deps (already copied there for install).
# The generated Prisma client is produced by `prisma generate` in the deps stage
# and overlaid on top of the source tree.
COPY --from=deps --chown=runner:runner /app/packages/db/prisma ./packages/db/prisma
COPY --chown=runner:runner packages/db/prisma.config.ts ./packages/db/prisma.config.ts
COPY --chown=runner:runner packages/db/sql ./packages/db/sql
COPY --chown=runner:runner packages/db/src ./packages/db/src
COPY --from=deps --chown=runner:runner /app/packages/db/src/generated ./packages/db/src/generated
COPY --chown=runner:runner packages/db/package.json ./packages/db/package.json
COPY --chown=runner:runner infra/migrations-runner/run.ts ./run.ts

# Root package.json and bunfig.toml — needed for workspace resolution of
# @ai-agents-observability/db and for `bun run.ts` to work.
COPY --chown=runner:runner package.json ./package.json
COPY --chown=runner:runner bunfig.toml ./bunfig.toml

USER runner

CMD ["bun", "run.ts"]
