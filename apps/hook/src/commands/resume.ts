import { rmSync } from 'node:fs';

import { pausedPath } from '../lib/paths';

export function runResume(): number {
  rmSync(pausedPath(), { force: true });
  process.stdout.write('Telemetry resumed.\n');
  return 0;
}
