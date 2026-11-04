'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { CaretRightIcon } from '@/components/icons';
import { TranscriptStatsBar } from '@/components/me/TranscriptStatsBar';
import {
  DEFAULT_TRANSCRIPT_LABELS,
  type TranscriptLabels,
  TranscriptTurnView,
} from '@/components/me/TranscriptTurnView';
import { Button } from '@/components/ui/Button';
import { cx } from '@/components/ui/cx';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Field';
import { Segmented, SegmentedButton } from '@/components/ui/Segmented';
import { computeStats, type ParsedLine, parseTranscriptLine } from '@/lib/transcript-parser';

// ── Legacy types for raw mode rendering ──────────────────────────────────────

type RawContent = { type?: string; [key: string]: unknown };
type RawMessage = { role?: string; content?: string | RawContent[]; [key: string]: unknown };
type RawLine = { type?: string; message?: RawMessage; raw?: string; [key: string]: unknown };

// ── Raw mode renderers (unchanged from original) ──────────────────────────────

function CopyButton({ value }: { value: unknown }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
        navigator.clipboard?.writeText(text).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          },
          () => {},
        );
      }}
      className="text-[10px] uppercase tracking-wide text-text-3 hover:text-accent transition-colors"
    >
      {copied ? 'copied' : 'copy'}
    </button>
  );
}

type TextBlock = { type: 'text'; text: string };
type ToolUseBlock = { type: 'tool_use'; name: string; input: unknown };
type ToolResultBlock = { type: 'tool_result'; content: unknown };
type ContentBlock =
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock
  | { type: string; [key: string]: unknown };

function TextBlockView({ block }: { block: TextBlock }) {
  return (
    <p className="whitespace-pre-wrap [overflow-wrap:anywhere] text-text-2 text-sm leading-relaxed">
      {block.text}
    </p>
  );
}

function ToolUseBlockView({ block }: { block: ToolUseBlock }) {
  const inputJson = JSON.stringify(block.input, null, 2);
  return (
    <details className="group rounded border border-accent-line bg-accent-dim text-sm">
      <summary className="cursor-pointer px-3 py-1.5 text-accent font-mono select-none list-none flex items-center gap-2">
        <CaretRightIcon
          size={10}
          className="text-text-3 shrink-0 transition-transform group-open:rotate-90"
        />
        <span className="text-xs text-text-3">tool</span>
        <span className="font-semibold">{block.name}</span>
      </summary>
      <pre className="px-3 pb-2 pt-1 text-xs text-text-2 overflow-x-auto whitespace-pre-wrap [overflow-wrap:anywhere]">
        {inputJson}
      </pre>
    </details>
  );
}

function ToolResultBlockView({ block }: { block: ToolResultBlock }) {
  const raw =
    typeof block.content === 'string'
      ? block.content
      : (JSON.stringify(block.content, null, 2) ?? '');
  // Shown in full: the <pre> scrolls (max-h-64), so nothing needs cutting.
  const isLong = raw.length > 500;
  return (
    <details className="group rounded border border-border bg-surface text-sm">
      <summary className="cursor-pointer px-3 py-1.5 text-text-3 font-mono select-none list-none flex items-center gap-2">
        <CaretRightIcon
          size={10}
          className="text-text-3 shrink-0 transition-transform group-open:rotate-90"
        />
        <span className="text-xs">tool result</span>
        {isLong && <span className="text-text-3 text-xs">({raw.length} chars)</span>}
      </summary>
      <pre className="px-3 pb-2 pt-1 text-xs text-text-3 overflow-x-auto whitespace-pre-wrap [overflow-wrap:anywhere] max-h-64 overflow-y-auto">
        {raw}
      </pre>
    </details>
  );
}

function UnknownBlockView({ block }: { block: { type: string; [key: string]: unknown } }) {
  return (
    <pre className="rounded bg-surface px-3 py-2 text-xs text-text-3 overflow-x-auto whitespace-pre-wrap [overflow-wrap:anywhere]">
      {JSON.stringify(block)}
    </pre>
  );
}

function ContentBlockView({ block }: { block: ContentBlock }) {
  if (block.type === 'text') {
    return <TextBlockView block={block as TextBlock} />;
  }
  if (block.type === 'tool_use') {
    return <ToolUseBlockView block={block as ToolUseBlock} />;
  }
  if (block.type === 'tool_result') {
    return <ToolResultBlockView block={block as ToolResultBlock} />;
  }
  return <UnknownBlockView block={block as { type: string; [key: string]: unknown }} />;
}

function MessageContent({ content }: { content: string | ContentBlock[] | undefined }) {
  if (content == null) {
    return null;
  }
  if (typeof content === 'string') {
    return <TextBlockView block={{ text: content, type: 'text' }} />;
  }
  if (Array.isArray(content)) {
    return (
      <div className="space-y-2">
        {content.map((block, i) => (
          <ContentBlockView key={i} block={block} />
        ))}
      </div>
    );
  }
  return (
    <pre className="text-xs text-text-3 whitespace-pre-wrap [overflow-wrap:anywhere]">
      {JSON.stringify(content)}
    </pre>
  );
}

function RawLine({ line }: { line: RawLine }) {
  if (line.raw !== undefined) {
    return (
      <div className="rounded px-3 py-2 bg-surface border border-border-subtle">
        <span className="text-xs text-text-3 mr-2">raw</span>
        <span className="text-xs text-text-3 font-mono [overflow-wrap:anywhere]">
          {String(line.raw)}
        </span>
      </div>
    );
  }

  const role =
    line.type === 'user'
      ? 'user'
      : line.type === 'assistant'
        ? 'assistant'
        : (line.type ?? 'unknown');
  const message = line.message;
  const effectiveRole = message?.role ?? role;
  const isUser = effectiveRole === 'user';
  const isAssistant = effectiveRole === 'assistant';

  return (
    <div
      className={cx(
        'min-w-0 rounded px-3 py-2 space-y-1 border',
        isUser
          ? 'bg-surface border-border-subtle'
          : isAssistant
            ? 'bg-accent-dim border-accent-line'
            : 'bg-surface border-border-subtle',
      )}
    >
      <div className="flex items-center justify-between mb-1">
        <span className="block text-xs text-text-3 capitalize">{effectiveRole}</span>
        <CopyButton value={message ?? line} />
      </div>
      {message ? (
        <MessageContent content={message.content as string | ContentBlock[] | undefined} />
      ) : (
        <pre className="text-xs text-text-3 whitespace-pre-wrap [overflow-wrap:anywhere]">
          {JSON.stringify(line)}
        </pre>
      )}
    </div>
  );
}

// ── Search helpers ────────────────────────────────────────────────────────────

function conversationSearchText(line: ParsedLine): string {
  if (line.kind === 'user-message') {
    return line.content;
  }
  if (line.kind === 'tool-results') {
    return line.results
      .map(
        (r) =>
          `${r.toolName ?? ''} ${typeof r.content === 'string' ? r.content : JSON.stringify(r.content)}`,
      )
      .join(' ');
  }
  if (line.kind === 'assistant-turn') {
    return line.blocks
      .map((b) => {
        if (b.type === 'text') {
          return (b as { text: string }).text ?? '';
        }
        if (b.type === 'tool_use') {
          const tb = b as { name: string; input: unknown };
          return `${tb.name} ${JSON.stringify(tb.input)}`;
        }
        return '';
      })
      .join(' ');
  }
  return JSON.stringify(line.src);
}

function rawSearchText(line: ParsedLine): string {
  return JSON.stringify(line.src);
}

// ── Viewer ────────────────────────────────────────────────────────────────────

const WINDOW_STEP = 300;

class HttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

export function TranscriptViewer({
  apiUrl,
  labels = DEFAULT_TRANSCRIPT_LABELS,
  sessionId,
}: {
  apiUrl?: string | undefined;
  labels?: TranscriptLabels;
  sessionId: string;
}) {
  const [parsedLines, setParsedLines] = useState<ParsedLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // HTTP status of a failed fetch; null for a network/parse failure.
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [visibleCount, setVisibleCount] = useState(WINDOW_STEP);
  const [viewMode, setViewMode] = useState<'conversation' | 'raw'>('conversation');
  // Bumped by Retry to re-run the fetch effect.
  const [attempt, setAttempt] = useState(0);

  const toolNameMapRef = useRef<Map<string, string>>(new Map());

  const url = apiUrl ?? `/api/me/transcripts/${sessionId}`;

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    toolNameMapRef.current = new Map();
    setParsedLines([]);
    setLoading(true);
    setError(null);
    setErrorStatus(null);
    setVisibleCount(WINDOW_STEP);

    (async () => {
      try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) {
          throw new HttpError(res.status);
        }
        const reader = res.body?.getReader();
        if (!reader) {
          const text = await res.text();
          if (!cancelled) {
            const lines = text
              .trim()
              .split('\n')
              .filter(Boolean)
              .map((l) => parseTranscriptLine(l, toolNameMapRef.current));
            setParsedLines(lines);
            setLoading(false);
          }
          return;
        }

        const decoder = new TextDecoder();
        let buf = '';
        let pending: ParsedLine[] = [];
        const flush = () => {
          if (pending.length > 0) {
            const batch = pending;
            pending = [];
            setParsedLines((prev) => prev.concat(batch));
          }
        };

        for (;;) {
          const { done, value } = await reader.read();
          if (cancelled) {
            return;
          }
          if (done) {
            break;
          }
          buf += decoder.decode(value, { stream: true });
          let nl = buf.indexOf('\n');
          while (nl !== -1) {
            const raw = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (raw.trim()) {
              pending.push(parseTranscriptLine(raw, toolNameMapRef.current));
            }
            nl = buf.indexOf('\n');
          }
          if (pending.length >= 200) {
            flush();
          }
        }
        buf += decoder.decode();
        if (buf.trim()) {
          pending.push(parseTranscriptLine(buf, toolNameMapRef.current));
        }
        flush();
        if (!cancelled) {
          setLoading(false);
        }
      } catch (err) {
        if (cancelled || (err instanceof DOMException && err.name === 'AbortError')) {
          return;
        }
        setErrorStatus(err instanceof HttpError ? err.status : null);
        setError(err instanceof Error ? err.message : 'Failed to load transcript');
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [url, attempt]);

  const stats = useMemo(() => computeStats(parsedLines), [parsedLines]);

  const modeFiltered = useMemo(
    () =>
      viewMode === 'conversation' ? parsedLines.filter((l) => l.kind !== 'metadata') : parsedLines,
    [parsedLines, viewMode],
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return modeFiltered;
    }
    const searchFn = viewMode === 'conversation' ? conversationSearchText : rawSearchText;
    return modeFiltered.filter((l) => searchFn(l).toLowerCase().includes(needle));
  }, [modeFiltered, query, viewMode]);

  if (loading && parsedLines.length === 0) {
    return <div className="animate-pulse motion-reduce:animate-none h-96 bg-surface rounded-lg" />;
  }
  if (error) {
    const accessDenied = errorStatus === 401 || errorStatus === 403;
    const notFound = errorStatus === 404;
    return (
      <div role="alert">
        {accessDenied ? (
          <EmptyState title="Access to this transcript was denied">
            Your access may have expired or been revoked. Reload the page or sign in again; if it
            persists, ask an org admin about your access grant.
          </EmptyState>
        ) : notFound ? (
          <EmptyState title="Transcript not found">
            It may not have been uploaded yet. The session's telemetry is unaffected; check back
            shortly.
          </EmptyState>
        ) : (
          <EmptyState
            title="Couldn't load this transcript"
            action={
              <Button size="sm" variant="secondary" onClick={() => setAttempt((n) => n + 1)}>
                Retry
              </Button>
            }
          >
            {errorStatus === null
              ? 'The connection failed.'
              : `The transcript store returned an error (HTTP ${errorStatus}).`}{' '}
            The session's telemetry is unaffected; try again in a moment.
          </EmptyState>
        )}
      </div>
    );
  }
  if (parsedLines.length === 0) {
    return <EmptyState title="No transcript content recorded yet." />;
  }

  const visible = filtered.slice(0, visibleCount);
  const remaining = filtered.length - visible.length;

  return (
    <div className="space-y-3">
      {(stats.userTurns > 0 || stats.toolCalls > 0) && <TranscriptStatsBar stats={stats} />}

      <div className="flex flex-wrap items-center gap-3">
        <Input
          type="search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setVisibleCount(WINDOW_STEP);
          }}
          aria-label="Search in transcript"
          placeholder="Search in transcript…"
          className="min-w-48 flex-1"
        />
        {/*
          Search-as-you-type with no live region gave no feedback at all: a
          sighted user watches the count change, everyone else typed into
          silence.

          `role="status"` (polite) rather than an assertive region, and
          deliberately: this text changes on EVERY keystroke, so an assertive
          region would interrupt the user mid-word, on every word. Polite
          announcements coalesce, so rapid typing produces one result when they
          pause — which is the moment the count is worth hearing.
        */}
        <span className="text-xs text-text-3 font-mono whitespace-nowrap" aria-hidden="true">
          {query.trim()
            ? `${filtered.length} / ${modeFiltered.length}`
            : `${modeFiltered.length.toLocaleString()} entries`}
          {loading ? ' · loading…' : ''}
        </span>
        <span role="status" className="sr-only">
          {query.trim()
            ? `${filtered.length} of ${modeFiltered.length} entries match`
            : `${modeFiltered.length} entries`}
          {loading ? ', loading' : ''}
        </span>
        <div className="shrink-0">
          <Segmented label="Transcript view">
            {(['conversation', 'raw'] as const).map((mode) => (
              <SegmentedButton
                key={mode}
                selected={viewMode === mode}
                onClick={() => {
                  setViewMode(mode);
                  setVisibleCount(WINDOW_STEP);
                }}
              >
                {mode === 'conversation' ? 'Conversation' : 'Raw'}
              </SegmentedButton>
            ))}
          </Segmented>
        </div>
      </div>

      {filtered.length === 0 ? (
        <p className="text-sm text-text-3">No entries match &quot;{query}&quot;.</p>
      ) : (
        <div className="min-w-0 space-y-2 font-mono text-sm">
          {visible.map((line, i) =>
            viewMode === 'conversation' ? (
              <TranscriptTurnView key={i} labels={labels} line={line} />
            ) : (
              <RawLine key={i} line={line.src as RawLine} />
            ),
          )}
        </div>
      )}

      {remaining > 0 && (
        <Button
          variant="secondary"
          className="w-full"
          onClick={() => setVisibleCount((c) => c + WINDOW_STEP)}
        >
          Show {Math.min(remaining, WINDOW_STEP)} more ({remaining} hidden)
        </Button>
      )}
    </div>
  );
}
