import { OrgRole, TeamRole } from '@ai-agents-observability/db';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { withRouteLogging } from '@/lib/api-logging';
import { AuditAction, writeAuditLog } from '@/lib/audit';
import { currentUser } from '@/lib/auth';
import { logger } from '@/lib/logger';
import { getPrisma } from '@/lib/prisma';
import { getRequestId } from '@/lib/request-context';
import { listActiveTeamSessions, resolveTeamVisibility } from '@/lib/team-queries';

export const dynamic = 'force-dynamic';
// E4: SSE endpoint — disable static optimization and keep the response alive.
// maxDuration is in seconds, MAX_STREAM_MS in milliseconds, and they are
// deliberately NOT equal: the stream closes itself at 240s so it always ends on
// its own terms, 30s inside the 270s platform ceiling. Keep that gap when
// tuning either one.
export const maxDuration = 270;

const POLL_INTERVAL_MS = 3000;
const MAX_STREAM_MS = 240_000; // 4 minutes — client reconnects via EventSource

// E4: Real-time session stream for team leads. Emits Server-Sent Events with
// snapshots of active (status='ACTIVE') sessions for visible team members.
// The stream polls the DB every 3s and emits a JSON snapshot. No WebSocket or
// Postgres LISTEN/NOTIFY infrastructure exists, so DB polling is the simplest
// approach. The client reconnects automatically via EventSource.
//
// Audit: the stream start is audited with VIEW_SESSION (fire-and-forget — a
// failed audit log should not kill the stream, since the stream only carries
// aggregate metadata, not transcript content).
export const GET = withRouteLogging(
  'team.sessions.stream',
  async (req: NextRequest, { params }: { params: Promise<{ slug: string }> }) => {
    const { slug } = await params;

    const user = await currentUser();
    if (!user) {
      return new NextResponse('Unauthorized', { status: 401 });
    }

    // Resolve team and check team-lead role (same gate as the team sessions page).
    const team = await getPrisma().team.findUnique({
      select: { id: true, name: true },
      where: { githubSlug: slug },
    });
    if (!team) {
      return new NextResponse('Not found', { status: 404 });
    }

    const membership = await getPrisma().teamMember.findUnique({
      select: { leftAt: true, roleInTeam: true },
      where: { teamId_userId: { teamId: team.id, userId: user.id } },
    });
    const isActiveMember = membership && !membership.leftAt;
    const isLead =
      isActiveMember &&
      (membership.roleInTeam === TeamRole.LEAD || membership.roleInTeam === TeamRole.MAINTAINER);
    const isAdmin = user.orgRole === OrgRole.ORG_ADMIN;
    if (!isAdmin && !isLead) {
      return new NextResponse('Forbidden', { status: 403 });
    }

    const { visibleIds } = await resolveTeamVisibility(team.id);
    const teamId = team.id;

    // Audit the stream start.
    void writeAuditLog({
      action: AuditAction.VIEW_SESSION,
      actorUserId: user.id,
      targetTeamId: teamId,
    });

    const streamStart = Date.now();
    const encoder = new TextEncoder();

    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        let closed = false;

        function sendEvent(data: unknown) {
          if (closed) {
            return;
          }
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
          } catch {
            closed = true;
          }
        }

        // Initial snapshot.
        try {
          const sessions = await listActiveTeamSessions(visibleIds);
          sendEvent({ sessions, ts: Date.now() });
        } catch (err) {
          logger.error(
            { err, reqId: getRequestId(), teamId },
            'team.sessions.stream.initial_failed',
          );
          sendEvent({ error: 'Failed to load active sessions', sessions: [], ts: Date.now() });
        }

        // Polling loop — use recursive setTimeout with a running guard so
        // overlapping DB polls cannot stack if a query takes longer than the
        // poll interval.
        let running = false;
        let timeoutId: ReturnType<typeof setTimeout> | undefined;

        function schedulePoll() {
          if (closed) {
            return;
          }
          timeoutId = setTimeout(pollOnce, POLL_INTERVAL_MS);
        }

        async function pollOnce() {
          if (closed || running) {
            schedulePoll();
            return;
          }
          running = true;

          if (Date.now() - streamStart > MAX_STREAM_MS) {
            sendEvent({ event: 'end', reason: 'max_duration' });
            try {
              controller.close();
            } catch {
              // already closed
            }
            closed = true;
            running = false;
            return;
          }

          try {
            const sessions = await listActiveTeamSessions(visibleIds);
            sendEvent({ sessions, ts: Date.now() });
          } catch (err) {
            logger.error(
              { err, reqId: getRequestId(), teamId },
              'team.sessions.stream.poll_failed',
            );
            sendEvent({
              error: 'Poll failed — showing last snapshot',
              sessions: [],
              ts: Date.now(),
            });
          } finally {
            running = false;
            schedulePoll();
          }
        }

        schedulePoll();

        // Clean up on abort (client disconnect).
        function onAbort() {
          closed = true;
          if (timeoutId !== undefined) {
            clearTimeout(timeoutId);
          }
          try {
            controller.close();
          } catch {
            // already closed
          }
        }

        req.signal.addEventListener('abort', onAbort, { once: true });
      },
    });

    return new NextResponse(body, {
      headers: {
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream',
        'X-Accel-Buffering': 'no',
      },
    });
  },
);
