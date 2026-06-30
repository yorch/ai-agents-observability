FROM oven/bun:1.3.14-alpine

RUN apk add --no-cache postgresql-client

RUN addgroup -g 1001 -S runner && adduser -S runner -u 1001 -G runner

WORKDIR /app

# Dependency layer — rebuild only when manifests change
COPY package.json bun.lock bunfig.toml ./
COPY apps/github-app/package.json apps/github-app/
COPY apps/hook/package.json apps/hook/
COPY apps/ingest/package.json apps/ingest/
COPY apps/web/package.json apps/web/
COPY packages/auth/package.json packages/auth/
COPY packages/db/package.json packages/db/
COPY packages/github/package.json packages/github/
COPY packages/redaction/package.json packages/redaction/
COPY packages/schemas/package.json packages/schemas/

# keytar (transitive native dep via packages/auth) compiles via node-gyp during
# install. Install its build toolchain as a virtual package and drop it afterward
# so this one-shot image stays lean. keytar is never loaded at runtime here (the
# runner only applies migrations), so no libsecret is needed at runtime.
RUN apk add --no-cache --virtual .build-deps build-base python3 libsecret-dev \
  && bun install --frozen-lockfile \
  && apk del .build-deps

# Source layer
COPY packages/db/prisma/ ./packages/db/prisma/
COPY packages/db/prisma.config.ts ./packages/db/prisma.config.ts
COPY packages/db/sql/ ./packages/db/sql/
COPY packages/db/src/ ./packages/db/src/
COPY infra/migrations-runner/run.ts ./run.ts

# Generate Prisma client — cd to packages/db so prisma.config.ts is picked up
RUN cd packages/db && bunx prisma generate && chown -R runner:runner /app

USER runner

CMD ["bun", "run.ts"]
