import { prisma } from '@ai-agents-observability/db';

// Re-export the singleton from @pkg/db. Next dev HMR creates many module
// instances; the package guards a globalThis-cached client to avoid pool
// exhaustion.
export { prisma };
