FROM oven/bun:1.3.14-alpine

RUN apk add --no-cache postgresql-client

RUN addgroup -g 1001 -S runner && adduser -S runner -u 1001 -G runner

WORKDIR /app

# Dependency layer — rebuild only when manifests change
COPY --chown=runner:runner package.json bun.lock bunfig.toml ./
COPY --chown=runner:runner apps/github-app/package.json apps/github-app/
COPY --chown=runner:runner apps/hook/package.json apps/hook/
COPY --chown=runner:runner apps/ingest/package.json apps/ingest/
COPY --chown=runner:runner apps/site/package.json apps/site/
COPY --chown=runner:runner apps/web/package.json apps/web/
COPY --chown=runner:runner packages/auth/package.json packages/auth/
COPY --chown=runner:runner packages/db/package.json packages/db/
COPY --chown=runner:runner packages/github/package.json packages/github/
COPY --chown=runner:runner packages/redaction/package.json packages/redaction/
COPY --chown=runner:runner packages/schemas/package.json packages/schemas/

# The root `postinstall` runs `prisma generate`, so the schema must be present
# before install. Copying it here (rather than skipping scripts) keeps native
# dependency builds — notably keytar via node-gyp — working.
COPY --chown=runner:runner packages/db/prisma.config.ts packages/db/
COPY --chown=runner:runner packages/db/prisma packages/db/prisma

# keytar (transitive native dep via packages/auth) compiles via node-gyp during
# install. Install its build toolchain as a virtual package and drop it afterward
# so this one-shot image stays lean. keytar is never loaded at runtime here (the
# runner only applies migrations), so no libsecret is needed at runtime.
RUN apk add --no-cache --virtual .build-deps build-base python3 libsecret-dev \
  && bun install --frozen-lockfile \
  && apk del .build-deps

# Source layer
COPY --chown=runner:runner packages/db/prisma/ ./packages/db/prisma/
COPY --chown=runner:runner packages/db/prisma.config.ts ./packages/db/prisma.config.ts
COPY --chown=runner:runner packages/db/sql/ ./packages/db/sql/
COPY --chown=runner:runner packages/db/src/ ./packages/db/src/
COPY --chown=runner:runner infra/migrations-runner/run.ts ./run.ts

# Generate Prisma client — cd to packages/db so prisma.config.ts is picked up
RUN cd packages/db && bunx prisma generate

# Ownership: source comes in via --chown above; node_modules and the generated
# client are created by root and are world-readable, which is all the runner
# needs — it only applies migrations and writes nothing under /app. The old
# `chown -R runner:runner /app` rewrote every file's metadata into a new layer,
# storing the whole tree a second time: that layer measured 1.17GB.
RUN chown runner:runner /app

USER runner

CMD ["bun", "run.ts"]
