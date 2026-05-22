import type { PrismaClient } from '@ai-agents-observability/db';
import { Cron } from 'croner';
import type { Logger } from 'pino';

import { runSweepAbandoned } from './sweep-abandoned';
import { runSyncTeams } from './sync-teams';

export function startScheduler(db: PrismaClient, logger?: Logger): void {
  // Hourly team sync
  new Cron('0 * * * *', { protect: true }, () => {
    runSyncTeams(db, logger).catch((err) => {
      logger?.error({ err }, 'Unhandled error in sync-teams job');
    });
  });

  // Every 10 minutes: sweep abandoned sessions
  new Cron('*/10 * * * *', { protect: true }, () => {
    runSweepAbandoned(db, logger).catch((err) => {
      logger?.error({ err }, 'Unhandled error in sweep-abandoned job');
    });
  });

  logger?.info('Job scheduler started (sync-teams: hourly, sweep-abandoned: every 10m)');
}
