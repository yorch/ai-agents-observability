import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'prisma/config';

// Prisma evaluates this file in an isolated subprocess that does not inherit
// env vars the parent loaded from .env. Read it explicitly so DATABASE_URL works.
const envPath = join(dirname(fileURLToPath(import.meta.url)), '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) {
      process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
}

export default defineConfig({
  schema: './prisma/schema.prisma',
  ...(process.env.DATABASE_URL && {
    datasource: { url: process.env.DATABASE_URL },
  }),
});
