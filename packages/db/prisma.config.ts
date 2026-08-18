import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: './prisma/schema.prisma',
  ...(process.env.DATABASE_URL && {
    datasource: {
      url: process.env.DATABASE_URL,
      // Only used by `prisma migrate diff --from-migrations`, which replays the
      // migrations directory into a throwaway database to compare against the
      // schema. Never touched at runtime.
      ...(process.env.SHADOW_DATABASE_URL && {
        shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
      }),
    },
  }),
});
