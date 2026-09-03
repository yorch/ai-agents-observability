'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Cell, EmptyState, Row, Table } from '@/components/ui';
import { fmtDurationSec, fmtUsdSession } from '@/lib/fmt';

// E4: Client component that subscribes to the active sessions SSE stream and
// renders a live table of in-progress sessions for team leads.

type ActiveSession = {
  agentType: string;
  costUsd: number;
  lastEventAt: string;
  ownerDisplayName: string | null;
  ownerLogin: string | null;
  primaryModel: string | null;
  repoName: string | null;
  sessionId: string;
  startedAt: string;
  toolCallCount: number;
  userMessageCount: number;
};

type StreamData = {
  sessions: ActiveSession[];
  ts?: number;
  error?: string;
  event?: string;
};

export function ActiveSessionStream({ slug }: { slug: string }) {
  const [sessions, setSessions] = useState<ActiveSession[]>([]);
  const [connected, setConnected] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);

  const streamUrl = `/api/team/${slug}/sessions/stream`;

  const handleData = useCallback((data: StreamData) => {
    if (data.event === 'end') {
      return;
    }
    // The discriminator is `error`, not the array length. The server sends
    // `sessions: []` for BOTH "the poll failed" and "nothing is active right
    // now", so keying off length kept the last snapshot forever: once a session
    // appeared it stayed in the table, still labelled Live, long after it ended.
    // Only an error frame should preserve the previous snapshot.
    if (data.error) {
      setStreamError(data.error);
      return;
    }
    setStreamError(null);
    setSessions(data.sessions ?? []);
    setLastUpdate(data.ts ?? Date.now());
  }, []);

  useEffect(() => {
    let es: EventSource | null = null;
    let consecutiveErrors = 0;
    let closed = false;
    const MAX_CONSECUTIVE_ERRORS = 5;

    function connect() {
      if (closed) {
        return;
      }
      es = new EventSource(streamUrl);

      es.onopen = () => {
        consecutiveErrors = 0;
        setConnected(true);
        setStreamError(null);
      };
      es.onerror = () => {
        setConnected(false);
        consecutiveErrors++;

        // EventSource does NOT auto-reconnect when the server answers with an
        // HTTP error (403/404/500) or the wrong content-type — it closes for
        // good and fires `error` exactly once. Waiting for
        // MAX_CONSECUTIVE_ERRORS therefore never happened on the failure that
        // matters most, and the widget sat on "Reconnecting…" forever. Read
        // readyState to tell a fatal close from a transient drop.
        const fatal = es?.readyState === EventSource.CLOSED;
        if (fatal || consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          es?.close();
          setStreamError(
            fatal
              ? 'Live updates unavailable — you may not have access to this team, or the stream was rejected. Retrying shortly.'
              : 'Live updates interrupted — retrying shortly.',
          );
          // Retry after a back-off delay.
          setTimeout(() => {
            if (!closed) {
              connect();
            }
          }, 10_000);
        }
        // Otherwise EventSource reconnects on its own.
      };
      es.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data) as StreamData;
          handleData(data);
        } catch {
          // ignore malformed data
        }
      };
    }

    connect();

    return () => {
      closed = true;
      es?.close();
    };
  }, [streamUrl, handleData]);

  if (sessions.length === 0) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-xs text-text-3">
          <LiveDot connected={connected} />
          <span>{connected ? 'Connected — no active sessions' : 'Reconnecting…'}</span>
          {lastUpdate && <span className="text-text-3">· updated {timeAgo(lastUpdate)}</span>}
        </div>
        {streamError && <p className="text-xs text-warn">{streamError}</p>}
        <EmptyState>No active sessions right now.</EmptyState>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-xs text-text-3">
        <LiveDot connected={connected} />
        <span>{connected ? 'Live' : 'Reconnecting…'}</span>
        <span>
          · {sessions.length} active session{sessions.length !== 1 ? 's' : ''}
        </span>
        {lastUpdate && <span>· updated {timeAgo(lastUpdate)}</span>}
      </div>
      {streamError && <p className="text-xs text-warn">{streamError}</p>}
      <Table
        columns={[
          { label: 'Member' },
          { label: 'Started' },
          { label: 'Repo' },
          { label: 'Model' },
          { align: 'right', label: 'Tools' },
          { align: 'right', label: 'Prompts' },
          { align: 'right', label: 'Cost' },
          { align: 'right', label: 'Last event' },
        ]}
      >
        {sessions.map((s) => {
          const sessionPath = `/team/${slug}/sessions/${s.sessionId}`;
          const lastEventMs = Date.now() - new Date(s.lastEventAt).getTime();
          const startedMs = Date.now() - new Date(s.startedAt).getTime();
          return (
            <Row key={s.sessionId}>
              <Cell className="text-text-2 text-xs">
                {s.ownerLogin ? (
                  <Link href={`/team/${slug}/member/${s.ownerLogin}`} className="hover:text-text">
                    {s.ownerDisplayName ?? `@${s.ownerLogin}`}
                  </Link>
                ) : (
                  <span className="text-text-3">—</span>
                )}
              </Cell>
              <Cell className="text-text-2 text-xs">
                <Link href={sessionPath} className="hover:text-text">
                  {fmtDurationSec(Math.round(startedMs / 1000))} ago
                </Link>
              </Cell>
              <Cell className="text-text-2 text-xs">{s.repoName ?? '—'}</Cell>
              <Cell className="text-text-2 text-xs">{s.primaryModel ?? '—'}</Cell>
              <Cell num className="text-text-2 text-xs">
                {s.toolCallCount.toLocaleString()}
              </Cell>
              <Cell num className="text-text-2 text-xs">
                {s.userMessageCount}
              </Cell>
              <Cell num className="text-text-2 text-xs">
                {fmtUsdSession(s.costUsd)}
              </Cell>
              <Cell num className="text-text-2 text-xs">
                {fmtDurationSec(Math.round(lastEventMs / 1000))} ago
              </Cell>
            </Row>
          );
        })}
      </Table>
    </div>
  );
}

function LiveDot({ connected }: { connected: boolean }) {
  return (
    <span
      className={`inline-block h-2 w-2 rounded-full ${connected ? 'bg-good' : 'bg-warn'}`}
      role="img"
      aria-label={connected ? 'Connected' : 'Reconnecting'}
    />
  );
}

function timeAgo(ts: number): string {
  const seconds = Math.round((Date.now() - ts) / 1000);
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.round(seconds / 60);
  return `${minutes}m ago`;
}
