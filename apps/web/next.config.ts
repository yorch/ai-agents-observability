import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Workspace packages ship TS sources; let Next compile them on demand.
  transpilePackages: [
    '@ai-agents-observability/auth',
    '@ai-agents-observability/db',
    '@ai-agents-observability/github',
  ],
};

export default nextConfig;
