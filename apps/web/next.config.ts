import path from 'node:path';
import type { NextConfig } from 'next';

// Baseline security headers applied to every route. The reverse proxy (Traefik,
// nginx, or a CDN) can tighten these further — e.g. submit the domain to the
// HSTS preload list, or narrow CSP by switching script-src to a nonce-based
// policy generated per-request in middleware. The CSP below allows
// 'unsafe-inline' on script-src and style-src because Next.js injects inline
// hydration scripts and the theme-toggle script in layout.tsx uses
// dangerouslySetInnerHTML; a nonce-based CSP would remove that allowance but is
// a larger change (middleware + per-request nonce propagation).
async function headers() {
  return [
    {
      headers: [
        { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains; preload' },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        {
          key: 'Content-Security-Policy',
          value: [
            "default-src 'self'",
            "script-src 'self' 'unsafe-inline'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data:",
            "font-src 'self'",
            "connect-src 'self'",
            "object-src 'none'",
            "base-uri 'self'",
            "frame-ancestors 'none'",
          ].join('; '),
        },
      ],
      source: '/(.*)',
    },
  ];
}

const nextConfig: NextConfig = {
  experimental: { useTypeScriptCli: true },
  headers,
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
