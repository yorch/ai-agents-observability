import type { PrismaClient } from '@ai-agents-observability/db';
import type { S3Client } from '@aws-sdk/client-s3';
import { Cron } from 'croner';
import type { Logger } from 'pino';

import { runComputeEffectiveness } from './compute-effectiveness';
import { runIndexTranscripts } from './index-transcripts';
import { runDeletions } from './run-deletions';
import { runSweepAbandoned } from './sweep-abandoned';
import { runSweepRetention } from './sweep-retention';
import { runSweepScratch } from './sweep-scratch';
import { runSyncTeams } from './sync-teams';

export type SchedulerDeps = {
  bucket: string;
  db: PrismaClient;
  githubSyncToken?: string;
  logger?: Logger;
  s3: S3Client;
  transcriptRetentionDays: number;
};

export function startScheduler(deps: SchedulerDeps): void {
  const { bucket, db, githubSyncToken, logger, s3, transcriptRetentionDays } = deps;

  // Hourly: team sync
  new Cron('0 * * * *', { protect: true }, () => {
    runSyncTeams(db, githubSyncToken, logger).catch((err) => {
      logger?.error({ err }, 'Unhandled error in sync-teams job');
    });
  });

  // Every 10 minutes: sweep abandoned sessions
  new Cron('*/10 * * * *', { protect: true }, () => {
    runSweepAbandoned(db, logger).catch((err) => {
      logger?.error({ err }, 'Unhandled error in sweep-abandoned job');
    });
  });

  // Hourly: remove stale transcript scratch files
  new Cron('0 * * * *', { protect: true }, () => {
    runSweepScratch(logger).catch((err) => {
      logger?.error({ err }, 'Unhandled error in sweep-scratch job');
    });
  });

  // Every 6 hours: process deletion requests (GDPR)
  new Cron('0 */6 * * *', { protect: true }, () => {
    runDeletions(db, s3, bucket, logger).catch((err) => {
      logger?.error({ err }, 'Unhandled error in run-deletions job');
    });
  });

  // Nightly at 02:00 UTC: enforce transcript retention
  new Cron('0 2 * * *', { protect: true }, () => {
    runSweepRetention(db, s3, bucket, transcriptRetentionDays, logger).catch((err) => {
      logger?.error({ err }, 'Unhandled error in sweep-retention job');
    });
  });

  // Nightly at 03:30 UTC: index transcript content for FTS
  // Staggered 90 min after sweep-retention (02:00) to avoid overlap on large buckets.
  new Cron('30 3 * * *', { protect: true }, () => {
    runIndexTranscripts(db as Parameters<typeof runIndexTranscripts>[0], s3, bucket, logger).catch(
      (err) => {
        logger?.error({ err }, 'Unhandled error in index-transcripts job');
      },
    );
  });

  // Nightly at 05:00 UTC: compute friction scores + shape labels
  // Staggered after index-transcripts (03:30) to allow ample processing time.
  new Cron('0 5 * * *', { protect: true }, () => {
    runComputeEffectiveness(db as Parameters<typeof runComputeEffectiveness>[0], logger).catch(
      (err) => {
        logger?.error({ err }, 'Unhandled error in compute-effectiveness job');
      },
    );
  });

  logger?.info(
    'Job scheduler started (sync-teams: hourly, sweep-abandoned: 10m, sweep-scratch: hourly, run-deletions: 6h, sweep-retention: 02:00 UTC, index-transcripts: 03:30 UTC, compute-effectiveness: 05:00 UTC)',
  );
}
