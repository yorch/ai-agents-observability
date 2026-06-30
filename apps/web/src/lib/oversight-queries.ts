import type { Prisma } from '@ai-agents-observability/db';
import {
  AUTONOMY_RANK,
  isLowOversightMode,
  type PermissionMode,
} from '@ai-agents-observability/schemas';
import { getPrisma } from './prisma';

// Human-in-the-loop "Oversight & Autonomy" summary (R4/R5). Built from the
// session-level signals captured in R1–R3: autonomy mode mix, approval friction,
// notification volume, and human response latency — plus a rubber-stamp / over-
// trust assessment (R5).

export type ModeMixEntry = { count: number; mode: string };

export type OversightSummary = {
  avgResponseMs: number | null;
  denyRate: number;
  interruptCount: number;
  lowOversightShare: number;
  modeMix: ModeMixEntry[];
  notificationCount: number;
  permissionDenyCount: number;
  permissionPromptCount: number;
  responseSampleCount: number;
  // R5: over-trust / rubber-stamp signal — high autonomy with vanishing scrutiny.
  rubberStamp: boolean;
  toolCallCount: number;
  totalSessions: number;
};

// Minimum sessions before the rubber-stamp signal is meaningful (avoids flagging
// a couple of bypass-mode sessions). Mirrors the alert engine's min-volume guard.
const RUBBER_STAMP_MIN_SESSIONS = 10;
// Below this mean human response time (ms) at blocking prompts, "review" looks
// reflexive rather than considered.
const RUBBER_STAMP_FAST_RESPONSE_MS = 2000;

function orderByAutonomy(mix: ModeMixEntry[]): ModeMixEntry[] {
  // Use the canonical AUTONOMY_RANK (single source of truth) — not array order.
  return [...mix].sort(
    (a, b) =>
      (AUTONOMY_RANK[a.mode as PermissionMode] ?? 99) -
      (AUTONOMY_RANK[b.mode as PermissionMode] ?? 99),
  );
}

async function oversightForWhere(where: Prisma.SessionWhereInput): Promise<OversightSummary> {
  const prisma = getPrisma();
  const [groups, agg, total] = await Promise.all([
    prisma.session.groupBy({ _count: { _all: true }, by: ['mode'], where }),
    prisma.session.aggregate({
      _sum: {
        interruptCount: true,
        notificationCount: true,
        permissionDenyCount: true,
        permissionPromptCount: true,
        responseSampleCount: true,
        toolCallCount: true,
        totalResponseMs: true,
      },
      where,
    }),
    prisma.session.count({ where }),
  ]);

  const modeMix = orderByAutonomy(
    groups
      .filter((g) => g.mode != null)
      .map((g) => ({ count: g._count._all, mode: g.mode as string })),
  );

  const lowOversightSessions = modeMix
    .filter((m) => isLowOversightMode(m.mode))
    .reduce((sum, m) => sum + m.count, 0);
  const lowOversightShare = total > 0 ? lowOversightSessions / total : 0;

  const toolCallCount = agg._sum.toolCallCount ?? 0;
  const permissionDenyCount = agg._sum.permissionDenyCount ?? 0;
  const denyRate = toolCallCount > 0 ? permissionDenyCount / toolCallCount : 0;

  const responseSampleCount = agg._sum.responseSampleCount ?? 0;
  const totalResponseMs = Number(agg._sum.totalResponseMs ?? 0n);
  const avgResponseMs = responseSampleCount > 0 ? totalResponseMs / responseSampleCount : null;

  const rubberStamp =
    total >= RUBBER_STAMP_MIN_SESSIONS &&
    lowOversightShare >= 0.5 &&
    denyRate < 0.01 &&
    avgResponseMs !== null &&
    avgResponseMs < RUBBER_STAMP_FAST_RESPONSE_MS;

  return {
    avgResponseMs,
    denyRate,
    interruptCount: agg._sum.interruptCount ?? 0,
    lowOversightShare,
    modeMix,
    notificationCount: agg._sum.notificationCount ?? 0,
    permissionDenyCount,
    permissionPromptCount: agg._sum.permissionPromptCount ?? 0,
    responseSampleCount,
    rubberStamp,
    toolCallCount,
    totalSessions: total,
  };
}

/** Per-user oversight summary for the "My Agents" trust-anchor view. */
export function getUserOversight(userId: string, since: Date): Promise<OversightSummary> {
  return oversightForWhere({ startedAt: { gte: since }, userId });
}

/**
 * Team-scoped oversight summary over the already visibility-resolved team member
 * ids (callers pass `visibleIds` from resolveTeamVisibility). An empty list yields
 * an all-zero summary (Prisma `in: []` matches nothing).
 */
export function getTeamOversight(userIds: string[], since: Date): Promise<OversightSummary> {
  return oversightForWhere({ startedAt: { gte: since }, userId: { in: userIds } });
}

/**
 * Org-wide oversight summary, visibility-scoped: only users who share metadata
 * with the org contribute (conservative default true when no policy row exists),
 * matching the alert engine and org dashboards.
 */
export function getOrgOversight(since: Date): Promise<OversightSummary> {
  return oversightForWhere({
    startedAt: { gte: since },
    user: {
      deactivatedAt: null,
      OR: [{ visibilityPolicy: { shareMetadataWithOrg: true } }, { visibilityPolicy: null }],
    },
  });
}
