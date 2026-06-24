import type { PrismaClient } from '@ai-agents-observability/db';
import { describe, expect, it, vi } from 'vitest';

import { applyAlertTransition } from '../src/jobs/alert-transition.ts';
import { effectiveRetentionDays } from '../src/jobs/retention-policy.ts';
import { buildAlertPayload } from '../src/lib/notify/payload.ts';

// Consolidated Phase 9 invariant suite (P9-006). Uses the Prisma-free policy
// helpers + property-style loops so it runs in CI without a live database.

describe('retention override bounds (P9-004 invariant)', () => {
  it('never exceeds the org max; null override = min(global, orgMax)', () => {
    const overrides = [null, 1, 30, 365, 730, 800, 5000];
    const globals = [0, 30, 365, 1000];
    const maxes = [90, 365, 730];
    for (const o of overrides) {
      for (const g of globals) {
        for (const m of maxes) {
          const eff = effectiveRetentionDays(o, g, m);
          expect(eff).toBeLessThanOrEqual(m);
          expect(eff).toBe(Math.min(o ?? g, m));
          if (o === null) {
            expect(eff).toBe(Math.min(g, m));
          }
        }
      }
    }
  });
});

describe('alert firing/resolution idempotency (P9-001 invariant)', () => {
  function statefulDb() {
    let open: { id: bigint; resolvedAt: Date | null } | null = null;
    const inserts: unknown[] = [];
    const resolves: bigint[] = [];
    const db = {
      _inserts: inserts,
      _resolves: resolves,
      alertEvent: {
        create: vi.fn(async (a: { data: unknown }) => {
          inserts.push(a.data);
          open = { id: 1n, resolvedAt: null };
          return open;
        }),
        findFirst: vi.fn(async () => open),
        update: vi.fn(async (a: { where: { id: bigint } }) => {
          resolves.push(a.where.id);
          open = null;
          return {};
        }),
      },
    };
    return db;
  }
  const asDb = (d: ReturnType<typeof statefulDb>) =>
    d as unknown as Pick<PrismaClient, 'alertEvent'>;
  const firing = { details: {}, severity: 'warn' as const };

  it('firing twice inserts exactly one open event', async () => {
    const db = statefulDb();
    await applyAlertTransition(asDb(db), 'r', firing);
    await applyAlertTransition(asDb(db), 'r', firing);
    expect(db._inserts).toHaveLength(1);
  });

  it('resolution happens once; a third pass does not re-resolve', async () => {
    const db = statefulDb();
    await applyAlertTransition(asDb(db), 'r', firing); // open
    await applyAlertTransition(asDb(db), 'r', null); // resolve
    await applyAlertTransition(asDb(db), 'r', null); // no-op
    expect(db._resolves).toEqual([1n]);
  });
});

describe('alert payload sanitization (P9-002 invariant)', () => {
  it('never echoes individual-identifying values, even if injected into details', () => {
    const secrets = ['u-9f3a', 'octocat', '01906a44-0000-7000-8000-000000000000'];
    for (let i = 0; i < 20; i++) {
      const payload = buildAlertPayload(
        { name: `rule ${i}`, ruleType: 'spend_spike' },
        {
          details: {
            avgCost: i,
            currentCost: i * 3,
            // Hostile inputs: ids that must never reach a channel.
            login: secrets[1],
            sessionId: secrets[2],
            sigma: 2 + i / 10,
            userId: secrets[0],
            windowDays: 7,
          },
          firedAt: new Date('2026-06-24T12:00:00Z'),
          severity: 'warn',
        },
      );
      const serialized = JSON.stringify(payload);
      for (const secret of secrets) {
        expect(serialized).not.toContain(secret);
      }
    }
  });
});
