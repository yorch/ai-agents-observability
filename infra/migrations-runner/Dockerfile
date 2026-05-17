FROM oven/bun:1.3.14-alpine

RUN apk add --no-cache postgresql-client

WORKDIR /app

# Dependency layer — rebuild only when manifests change
COPY package.json bun.lock bunfig.toml ./
COPY packages/db/package.json ./packages/db/package.json

RUN bun install --frozen-lockfile

# Source layer
COPY packages/db/prisma/ ./packages/db/prisma/
COPY packages/db/prisma.config.ts ./packages/db/prisma.config.ts
COPY packages/db/sql/ ./packages/db/sql/
COPY packages/db/src/ ./packages/db/src/
COPY infra/migrations-runner/run.ts ./run.ts

# Generate Prisma client — cd to packages/db so prisma.config.ts is picked up
RUN cd packages/db && bunx prisma generate

CMD ["bun", "run.ts"]
