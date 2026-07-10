import { getJiraProjectAllowlist } from '@ai-agents-observability/db';
import type { Event } from '@ai-agents-observability/schemas';
import { EventSchema, EventsBatchEnvelopeSchema } from '@ai-agents-observability/schemas';
import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Logger } from 'pino';

import { verifyIdentityClaim } from '../lib/identity';
import { insertEventsBatch } from '../lib/insert-events';
import { eventsIngestedTotal, unknownModelEventsTotal } from '../lib/metrics';
import type { PriceTableRegistry } from '../lib/price-tables';
import { linkSessionToPR } from '../lib/session-pr-link';
import { upsertSessions } from '../lib/upsert-session';
import type { AppEnv, EventsDb } from '../types';

// A full 500-event batch (each event carrying tool + llm + metadata blocks) can
// plausibly exceed 1 MB, which would 413 a legitimate max batch before the
// 500-count check runs. 8 MB keeps headroom over the worst-case batch while
// still bounding memory per request.
const MAX_BODY_BYTES = 8 * 1_048_576; // 8 MB

export function eventsRouter(
  db: EventsDb,
  priceTables: PriceTableRegistry,
  logger: Logger,
  // Operator-configured Jira project codes (JIRA_PROJECT_KEYS), unioned with
  // synced jira_issues project keys to constrain session key extraction.
  jiraProjectKeys: readonly string[] = [],
): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.post(
    '/',
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => {
        logger.warn(
          { reqId: c.get('requestId'), size_limit_bytes: MAX_BODY_BYTES },
          'ingest.events.body_too_large',
        );
        return c.json({ error: 'Request body too large' }, 413);
      },
    }),
    // Validate the envelope structure (and the fallback session_context) up
    // front, but leave the events array unparsed — each event is validated
    // individually below so one malformed event can't reject the whole batch.
    zValidator('json', EventsBatchEnvelopeSchema, (result, c) => {
      if (!result.success) {
        return c.json({ error: 'Validation error', issues: result.error.issues }, 400);
      }
      return;
    }),
    async (c) => {
      const envelope = c.req.valid('json');

      if (envelope.events.length > 500) {
        logger.warn(
          { batch_size: envelope.events.length, reqId: c.get('requestId') },
          'ingest.events.batch_too_large',
        );
        return c.json({ error: 'Batch exceeds 500 events' }, 413);
      }

      // Tolerant per-event validation: keep the valid events, drop + count the
      // rejected ones. Dropping invalid events is correct (a retry would replay
      // the same bad data); the flusher deletes the rows on our 202.
      const events: Event[] = [];
      let rejected = 0;
      for (const raw of envelope.events) {
        const parsed = EventSchema.safeParse(raw);
        if (parsed.success) {
          events.push(parsed.data);
        } else {
          rejected += 1;
        }
      }
      if (rejected > 0) {
        logger.warn(
          { rejected, reqId: c.get('requestId'), total: envelope.events.length },
          'ingest.events.rejected_invalid',
        );
      }

      const batch = { events, session_context: envelope.session_context };

      const userId = verifyIdentityClaim(c, batch.events[0]?.user_id_claim, logger);

      // Upsert every distinct (owner, repo) we see across events. A batch can
      // legitimately span repos when the hook flushes a queue mid-cwd-change.
      const repoKeys = new Set<string>();
      for (const ev of batch.events) {
        const git = ev.session_context.git;
        if (git?.owner && git?.repo) {
          repoKeys.add(`${git.owner}/${git.repo}`);
        }
      }
      const topGit = batch.session_context.git;
      if (topGit?.owner && topGit?.repo) {
        repoKeys.add(`${topGit.owner}/${topGit.repo}`);
      }
      const repoIdByKey = new Map<string, string>();
      for (const key of repoKeys) {
        const [owner, name] = key.split('/', 2) as [string, string];
        const row = await db.repo.upsert({
          create: { githubName: name, githubOwner: owner },
          update: {},
          where: { githubOwner_githubName: { githubName: name, githubOwner: owner } },
        });
        repoIdByKey.set(key, row.id);
      }

      // Resolve hook-reported team names to synced Team rows so sessions carry a
      // real team_id FK, not just the denormalized github_team string. The hook
      // sends the team *name* (not the org-qualified slug); only unambiguous
      // names resolve — a name shared by several teams stays unresolved.
      const teamNames = new Set<string>();
      for (const ev of batch.events) {
        const team = ev.session_context.git?.team;
        if (team) {
          teamNames.add(team);
        }
      }
      if (topGit?.team) {
        teamNames.add(topGit.team);
      }
      const teamIdByName = new Map<string, string>();
      if (teamNames.size > 0) {
        const teams = await db.team.findMany({
          select: { id: true, name: true },
          where: { name: { in: [...teamNames] } },
        });
        const ambiguous = new Set<string>();
        for (const t of teams) {
          if (teamIdByName.has(t.name)) {
            ambiguous.add(t.name);
          } else {
            teamIdByName.set(t.name, t.id);
          }
        }
        for (const name of ambiguous) {
          teamIdByName.delete(name);
        }
      }

      // Project-key allowlist for session jira_key extraction (cached 5 min in
      // packages/db; falls back to accept-all when no keys are known yet).
      const jiraProjectAllowlist = await getJiraProjectAllowlist(db, jiraProjectKeys);

      const reqId = c.get('requestId');
      const start = Date.now();

      // Insert events and aggregate sessions atomically. If aggregation fails
      // after the events commit, a retry would replay the same event_ids — but
      // ON CONFLICT DO NOTHING swallows them, leaving acceptedEventIds empty and
      // the session aggregate never updated (permanent, unrecoverable drift). A
      // single transaction makes the retry re-insert AND re-aggregate together.
      const { acceptedEvents, inserted, aggregated } = await db.$transaction(
        async (tx) => {
          const insertedTx = await insertEventsBatch(tx, batch.events, userId, priceTables);

          // Only feed newly-inserted events into the per-session accumulator.
          const acceptedEventsTx = batch.events.filter((e) =>
            insertedTx.acceptedEventIds.has(e.event_id),
          );
          const aggregatedTx = await upsertSessions(
            tx,
            acceptedEventsTx,
            userId,
            repoIdByKey,
            priceTables,
            topGit,
            teamIdByName,
            jiraProjectAllowlist,
          );
          return {
            acceptedEvents: acceptedEventsTx,
            aggregated: aggregatedTx,
            inserted: insertedTx,
          };
        },
        // A full 500-event batch (multi-row INSERT + per-session UPSERTs) can
        // exceed Prisma's 5s default interactive-transaction timeout under load;
        // raise it so a heavy-but-healthy batch isn't rolled back and retried whole.
        { maxWait: 5_000, timeout: 30_000 },
      );

      // Increment Prometheus counter for each accepted event, labelled by agent type.
      if (inserted.accepted > 0) {
        const agentType = batch.events[0]?.agent_type ?? 'CLAUDE_CODE';
        eventsIngestedTotal.inc({ agent_type: agentType }, inserted.accepted);
      }

      if (inserted.unknownModels.size > 0) {
        unknownModelEventsTotal.inc(inserted.unknownModels.size);
        logger.warn(
          { models: [...inserted.unknownModels], reqId },
          'ingest.events.unknown_model_zero_cost',
        );
      }

      // Best-effort session→PR linking (P2-004). Fire-and-forget; errors don't fail the request.
      Promise.allSettled(
        acceptedEvents
          .filter((e) => e.session_context.git?.pr_number != null)
          .map((e) => {
            const git = e.session_context.git;
            if (!git?.owner || !git.repo || git.pr_number == null) {
              return Promise.resolve();
            }
            const key = `${git.owner}/${git.repo}`;
            const repoId = repoIdByKey.get(key);
            if (!repoId) {
              return Promise.resolve();
            }
            return linkSessionToPR(db, e.session_id, repoId, git.pr_number);
          }),
      ).then((results) => {
        const failures = results.filter((r) => r.status === 'rejected');
        if (failures.length > 0) {
          logger.debug({ count: failures.length, reqId }, 'ingest.events.pr_link_failed');
        }
      });

      logger.info(
        {
          accepted: inserted.accepted,
          deduped: inserted.deduped,
          duration_ms: Date.now() - start,
          rejected,
          reqId,
          sessions_touched: aggregated.sessionsTouched,
          total: envelope.events.length,
        },
        'ingest.events.accepted',
      );

      return c.json(
        {
          accepted: inserted.accepted,
          deduped: inserted.deduped,
          rejected,
          request_id: reqId,
          sessions_touched: aggregated.sessionsTouched,
        },
        202,
      );
    },
  );

  return router;
}
