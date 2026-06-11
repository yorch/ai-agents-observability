import path from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  // Prisma's generated client is gitignored and created at build time.
  // Next.js's file tracer doesn't reliably pick up generated code, so we
  // force-include it here so the standalone bundle contains the client.
  outputFileTracingIncludes: {
    '**': ['../../packages/db/src/generated/**/*'],
  },
  // Trace workspace deps from the monorepo root into the standalone bundle.
  outputFileTracingRoot: path.join(import.meta.dirname, '../../'),
  // keytar is a native node module pulled in transitively via @pkg/auth's
  // hook-binary keychain helpers. The web bundle never calls it, but Turbopack
  // walks the import graph — keep it external so server runtime resolves it
  // via require().
  serverExternalPackages: ['keytar'],
  // Workspace packages ship TS sources; let Next compile them on demand.
  transpilePackages: [
    '@ai-agents-observability/auth',
    '@ai-agents-observability/db',
    '@ai-agents-observability/github',
  ],
};

export default nextConfig;
