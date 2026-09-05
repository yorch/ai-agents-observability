/**
 * The jobs `/admin/jobs` may enable, reschedule, or run. Mirrors
 * `CONFIGURABLE_JOBS` in `apps/ingest/src/jobs/scheduler.ts` — the scheduler is
 * the only reader of an hour+minute cadence, so a job outside that list has no
 * schedule for the form to edit. (`apps/web` cannot import from `apps/ingest`;
 * `test/configurable-jobs.test.ts` reads the scheduler's source as text and
 * fails if the two drift, the same way `turn-linkage.test.ts` pins the hook's
 * metadata key.)
 *
 * This lives outside `admin/jobs/actions.ts` because that file is `'use server'`,
 * which may export only async functions — and the page needs the same list to
 * tell "you can enable this" apart from "this is not yours to enable".
 *
 * **A row in `job_config` is not proof a job belongs here.** `POST
 * /admin/jobs/:name/run` on the ingest service upserts a placeholder row
 * (`enabled = false`, 00:00) for every name it accepts, so a fixed-timer or
 * operator-only job acquires a row — and therefore a row on this page — the
 * first time anyone triggers it. Without this list, ticking Enabled on one of
 * those would put it on a nightly schedule it was deliberately never given:
 *
 *   - `reprice-events-apply` is the write half of a two-name interlock. The bare
 *     `reprice-events` reports what repricing history would change; `-apply`
 *     rewrites `events.cost_usd` and moves the session/PR/cagg totals with it.
 *     The name was split precisely so that rewrite is never the default — a
 *     nightly schedule for it would undo the interlock from the UI.
 *   - `run-deletions` is the GDPR deletion job, on a fixed 6-hourly timer in the
 *     scheduler. Its cadence is not an operator setting.
 *   - `sync-teams`, `sync-jira`, `sweep-abandoned`, `sweep-scratch` and
 *     `backfill-redaction` are fixed-timer or one-shot operator drains, with no
 *     cadence to edit.
 */
export const CONFIGURABLE_JOBS: ReadonlySet<string> = new Set([
  'sweep-retention',
  'index-transcripts',
  'compute-effectiveness',
  'compute-trajectory-scores',
  'compute-subject-scores',
  'link-turn-events',
  'compute-cost-attribution',
  'evaluate-alerts',
  'refresh-caggs',
  'judge-sessions',
  'send-report-digest',
]);
