import { Prisma } from '@ai-agents-observability/db';
import { AuditAction, writeAuditLog } from './audit';
import { currentUser } from './auth';
import { getPrisma } from './prisma';
import { resolveOrgSessionAccess } from './roles';
import type { SessionDetail, SessionToolRow } from './sessions-queries';
import { getSession, getSessionOrgContext, getSessionToolBreakdown } from './sessions-queries';

// E2: Session comparison/diff — loads two sessions' details, tool breakdowns,
// and PR outcomes for a side-by-side view. Visibility is enforced per session
// via resolveOrgSessionAccess, the same gate the org session detail page uses.

export type SessionOutcome = {
  prCiStatus: string | null;
  prNumber: number | null;
  prReviewDecision: string | null;
  prState: string | null;
  prMergedAt: Date | null;
  prRevertedAt: Date | null;
};

export type SessionComparisonSide = {
  detail: SessionDetail;
  outcome: SessionOutcome;
  tools: SessionToolRow[];
};

export type SessionComparison = {
  left: SessionComparisonSide;
  right: SessionComparisonSide;
};

export type SessionComparisonError = {
  error: string;
  status: number;
};

async function loadSessionSide(
  sessionId: string,
): Promise<SessionComparisonSide | SessionComparisonError> {
  const ctx = await getSessionOrgContext(sessionId);
  if (!ctx) {
    return { error: 'Session not found', status: 404 };
  }

  const user = await currentUser();
  if (!user) {
    return { error: 'Unauthorized', status: 401 };
  }

  const access = await resolveOrgSessionAccess(user, {
    ownerUserId: ctx.ownerUserId,
    sessionId,
  });
  if (!access) {
    return { error: 'Forbidden', status: 403 };
  }

  // Audit the privileged cross-user metadata view, like the session detail
  // page does. Fire-and-forget: the compare page shows metadata, not transcript
  // content, so a failed audit log should not block the page.
  void writeAuditLog({
    action: AuditAction.VIEW_SESSION,
    actorUserId: user.id,
    targetSessionId: sessionId,
    targetUserId: ctx.ownerUserId,
  });

  const [detail, toolBreakdown] = await Promise.all([
    getSession(ctx.ownerUserId, sessionId),
    getSessionToolBreakdown(ctx.ownerUserId, sessionId),
  ]);

  if (!detail) {
    return { error: 'Session not found', status: 404 };
  }

  const outcome = await getSessionOutcome(sessionId);

  return {
    detail,
    outcome,
    tools: toolBreakdown.tools,
  };
}

/** Fetch PR outcome fields for a session via session_pr_links → pull_requests. */
async function getSessionOutcome(sessionId: string): Promise<SessionOutcome> {
  const pr = await getPrisma().$queryRaw<
    {
      pr_ci_status: string | null;
      pr_merged_at: Date | null;
      pr_number: number | null;
      pr_review_decision: string | null;
      pr_reverted_at: Date | null;
      pr_state: string | null;
    }[]
  >(Prisma.sql`
    SELECT
      s.pr_number                          AS pr_number,
      s.pr_ci_status                       AS pr_ci_status,
      s.pr_review_decision                 AS pr_review_decision,
      pr.state::text                       AS pr_state,
      pr.merged_at                         AS pr_merged_at,
      pr.reverted_at                       AS pr_reverted_at
    FROM interactive_sessions s
    LEFT JOIN session_pr_links spl
      ON spl.session_id = s.session_id::uuid
    LEFT JOIN pull_requests pr
      ON pr.repo_id = spl.repo_id
     AND pr.pr_number = spl.pr_number
     AND spl.pr_number = s.pr_number
    WHERE s.session_id = ${sessionId}::uuid
    ORDER BY spl.linked_at DESC
    LIMIT 1
  `);

  const row = pr[0];
  return {
    prCiStatus: row?.pr_ci_status ?? null,
    prMergedAt: row?.pr_merged_at ?? null,
    prNumber: row?.pr_number ?? null,
    prRevertedAt: row?.pr_reverted_at ?? null,
    prReviewDecision: row?.pr_review_decision ?? null,
    prState: row?.pr_state ?? null,
  };
}

export async function getSessionComparison(
  leftId: string,
  rightId: string,
): Promise<SessionComparison | SessionComparisonError> {
  if (leftId === rightId) {
    return { error: 'Cannot compare a session with itself', status: 400 };
  }

  const [left, right] = await Promise.all([loadSessionSide(leftId), loadSessionSide(rightId)]);

  if ('error' in left) {
    return left;
  }
  if ('error' in right) {
    return right;
  }

  return { left, right };
}

// ── Diff helpers (pure, for the UI) ──────────────────────────────────────────

export type MetricDelta = {
  left: number | null;
  right: number | null;
  /** right − left, or null when either side is null. */
  delta: number | null;
};

export function metricDelta(left: number | null, right: number | null): MetricDelta {
  if (left === null || right === null) {
    return { delta: null, left, right };
  }
  return { delta: right - left, left, right };
}

export type ToolMixDiffRow = {
  leftCalls: number;
  leftErrors: number;
  rightCalls: number;
  rightErrors: number;
  toolCategory: string | null;
  toolName: string;
};

/** Join two sessions' tool rows by tool name, producing a diff table. */
export function diffToolMix(left: SessionToolRow[], right: SessionToolRow[]): ToolMixDiffRow[] {
  // Aggregate by toolName first, since getSessionToolBreakdown groups by
  // (tool_name, tool_category) and the same tool can appear with different
  // categories. Summing calls and errors avoids losing rows.
  function aggregate(rows: SessionToolRow[]): Map<string, SessionToolRow> {
    const byName = new Map<string, SessionToolRow>();
    for (const row of rows) {
      const existing = byName.get(row.toolName);
      if (existing) {
        byName.set(row.toolName, {
          ...existing,
          callCount: existing.callCount + row.callCount,
          errorCount: existing.errorCount + row.errorCount,
        });
      } else {
        byName.set(row.toolName, { ...row });
      }
    }
    return byName;
  }

  const leftAgg = aggregate(left);
  const rightAgg = aggregate(right);
  const allNames = new Set([...leftAgg.keys(), ...rightAgg.keys()]);

  return [...allNames]
    .map((toolName) => {
      const l = leftAgg.get(toolName);
      const r = rightAgg.get(toolName);
      return {
        leftCalls: l?.callCount ?? 0,
        leftErrors: l?.errorCount ?? 0,
        rightCalls: r?.callCount ?? 0,
        rightErrors: r?.errorCount ?? 0,
        toolCategory: l?.toolCategory ?? r?.toolCategory ?? null,
        toolName,
      };
    })
    .sort((a, b) => b.leftCalls + b.rightCalls - (a.leftCalls + a.rightCalls));
}
