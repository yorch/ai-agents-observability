import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { pausedPath } from '../lib/paths';

export function runPause(): number {
  const path = pausedPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '', { encoding: 'utf8' });
  process.stdout.write('Telemetry paused. Run `claude-telemetry resume` to resume.\n');
  return 0;
}
