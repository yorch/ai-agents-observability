import { readFile } from 'node:fs/promises';
import path from 'node:path';

const dist = path.resolve(import.meta.dirname, '../dist');
const base = '/ai-agents-observability/';
const [home, docs, overview] = await Promise.all([
  readFile(path.join(dist, 'index.html'), 'utf8'),
  readFile(path.join(dist, 'docs/index.html'), 'utf8'),
  readFile(path.join(dist, 'docs/project-overview/index.html'), 'utf8'),
]);

const assertions = [
  [home.includes('Agentometry'), 'landing page contains the provisional brand'],
  [home.includes(`${base}docs/`), 'landing page links to documentation through the Pages base'],
  [home.includes(`${base}_astro/`), 'landing assets use the Pages base'],
  [docs.includes('Documentation'), 'documentation index is rendered'],
  [overview.includes('Project Overview'), 'root documentation is rendered in place'],
] as const;

for (const [passed, message] of assertions) {
  if (!passed) {
    throw new Error(`Pages verification failed: ${message}`);
  }
}

console.log(`Verified ${assertions.length} GitHub Pages output assertions.`);
