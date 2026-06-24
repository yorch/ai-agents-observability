import type { PrismaClient } from '@ai-agents-observability/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { applyAlertTransition } from '../src/jobs/alert-transition.ts';

type OpenEvent = { id: bigint; resolvedAt: Date | null };

function makeDb(initialOpen: OpenEvent | null) {
  let open = initialOpen;
  const created: unknown[] = [];
  const resolved: bigint[] = [];
  const db = {
    _created: created,
    _resolved: resolved,
    alertEvent: {
      create: vi.fn(async (args: { data: unknown }) => {
        created.push(args.data);
        open = { id: 99n, resolvedAt: null };
        return open;
      }),
      findFirst: vi.fn(async () => open),
      update: vi.fn(async (args: { where: { id: bigint } }) => {
        resolved.push(args.where.id);
        open = null;
        return {};
      }),
    },
  };
  return db;
}

function asDb(db: ReturnType<typeof makeDb>): Pick<PrismaClient, 'alertEvent'> {
  return db as unknown as Pick<PrismaClient, 'alertEvent'>;
}

const FIRING = { details: { currentCost: 100 }, severity: 'warn' as const };

describe('applyAlertTransition', () => {
  let db: ReturnType<typeof makeDb>;

  beforeEach(() => {
    db = makeDb(null);
  });

  it('fires (inserts one open event) when the condition is firing and none is open', async () => {
    const outcome = await applyAlertTransition(asDb(db), 'rule-1', FIRING);
    expect(outcome).toBe('fired');
    expect(db._created).toHaveLength(1);
  });

  it('does not double-fire when an open event already exists (idempotent)', async () => {
    const withOpen = makeDb({ id: 7n, resolvedAt: null });
    const outcome = await applyAlertTransition(asDb(withOpen), 'rule-1', FIRING);
    expect(outcome).toBe('noop');
    expect(withOpen._created).toHaveLength(0);
  });

  it('resolves the open event once when the condition clears', async () => {
    const withOpen = makeDb({ id: 7n, resolvedAt: null });
    const outcome = await applyAlertTransition(asDb(withOpen), 'rule-1', null);
    expect(outcome).toBe('resolved');
    expect(withOpen._resolved).toEqual([7n]);
  });

  it('is a no-op when not firing and nothing is open', async () => {
    const outcome = await applyAlertTransition(asDb(db), 'rule-1', null);
    expect(outcome).toBe('noop');
    expect(db._created).toHaveLength(0);
    expect(db._resolved).toHaveLength(0);
  });
});
