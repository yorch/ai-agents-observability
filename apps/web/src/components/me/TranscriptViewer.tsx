'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { TranscriptStatsBar } from '@/components/me/TranscriptStatsBar';
import { TranscriptTurnView } from '@/components/me/TranscriptTurnView';
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
  return <p className="whitespace-pre-wrap text-text-2 text-sm leading-relaxed">{block.text}</p>;
}

function ToolUseBlockView({ block }: { block: ToolUseBlock }) {
  const inputJson = JSON.stringify(block.input, null, 2);
  return (
    <details className="rounded border border-accent/20 bg-accent/5 text-sm">
      <summary className="cursor-pointer px-3 py-1.5 text-accent font-mono select-none list-none flex items-center gap-2">
        <span className="text-text-3">▶</span>
        <span className="text-xs text-text-3">tool</span>
        <span className="font-semibold">{block.name}</span>
      </summary>
      <pre className="px-3 pb-2 pt-1 text-xs text-text-2 overflow-x-auto whitespace-pre-wrap break-words">
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
  const isLong = raw.length > 500;
  return (
    <details className="rounded border border-border bg-surface text-sm">
      <summary className="cursor-pointer px-3 py-1.5 text-text-3 font-mono select-none list-none flex items-center gap-2">
        <span className="text-text-3">▶</span>
        <span className="text-xs">tool result</span>
        {isLong && <span className="text-text-3 text-xs">({raw.length} chars)</span>}
      </summary>
      <pre className="px-3 pb-2 pt-1 text-xs text-text-3 overflow-x-auto whitespace-pre-wrap break-words max-h-64 overflow-y-auto">
        {isLong ? `${raw.slice(0, 500)}…` : raw}
      </pre>
    </details>
  );
}

function UnknownBlockView({ block }: { block: { type: string; [key: string]: unknown } }) {
  return (
    <pre className="rounded bg-surface px-3 py-2 text-xs text-text-3 overflow-x-auto whitespace-pre-wrap break-words">
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
    <pre className="text-xs text-text-3 whitespace-pre-wrap break-words">
      {JSON.stringify(content)}
    </pre>
  );
}

function RawLine({ line }: { line: RawLine }) {
  if (line.raw !== undefined) {
    return (
      <div className="rounded px-3 py-2 bg-surface border border-border-subtle">
        <span className="text-xs text-text-3 mr-2">raw</span>
        <span className="text-xs text-text-3 font-mono">{String(line.raw)}</span>
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
      className={`rounded px-3 py-2 space-y-1 ${
        isUser
          ? 'bg-surface border border-border-subtle'
          : isAssistant
            ? 'bg-accent/5 border border-accent/15'
            : 'bg-surface border border-border-subtle'
      }`}
    >
      <div className="flex items-center justify-between mb-1">
        <span className="block text-xs text-text-3 capitalize">{effectiveRole}</span>
        <CopyButton value={message ?? line} />
      </div>
      {message ? (
        <MessageContent content={message.content as string | ContentBlock[] | undefined} />
      ) : (
        <pre className="text-xs text-text-3 whitespace-pre-wrap break-words">
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

export function TranscriptViewer({
  apiUrl,
  sessionId,
}: {
  apiUrl?: string | undefined;
  sessionId: string;
}) {
  const [parsedLines, setParsedLines] = useState<ParsedLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [visibleCount, setVisibleCount] = useState(WINDOW_STEP);
  const [viewMode, setViewMode] = useState<'conversation' | 'raw'>('conversation');

  const toolNameMapRef = useRef<Map<string, string>>(new Map());

  const url = apiUrl ?? `/api/me/transcripts/${sessionId}`;

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    toolNameMapRef.current = new Map();
    setParsedLines([]);
    setLoading(true);
    setError(null);
    setVisibleCount(WINDOW_STEP);

    (async () => {
      try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
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
        setError(err instanceof Error ? err.message : 'Failed to load transcript');
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [url]);

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
    return <div className="animate-pulse h-96 bg-surface rounded-lg" />;
  }
  if (error) {
    return <p className="text-sm text-red-400">Error: {error}</p>;
  }
  if (parsedLines.length === 0) {
    return <p className="text-sm text-text-3">Transcript is empty.</p>;
  }

  const visible = filtered.slice(0, visibleCount);
  const remaining = filtered.length - visible.length;

  return (
    <div className="space-y-3">
      {(stats.userTurns > 0 || stats.toolCalls > 0) && <TranscriptStatsBar stats={stats} />}

      <div className="flex items-center gap-3">
        <input
          type="search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setVisibleCount(WINDOW_STEP);
          }}
          placeholder="Search in transcript…"
          className="flex-1 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-text placeholder-text-3 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
        />
        <span className="text-xs text-text-3 font-mono whitespace-nowrap">
          {query.trim()
            ? `${filtered.length} / ${modeFiltered.length}`
            : `${modeFiltered.length} lines`}
          {loading ? ' · loading…' : ''}
        </span>
        <div className="flex items-center gap-0.5 rounded-lg border border-border bg-surface p-0.5 shrink-0">
          <button
            type="button"
            onClick={() => {
              setViewMode('conversation');
              setVisibleCount(WINDOW_STEP);
            }}
            className={`rounded px-2.5 py-1 text-xs transition-colors ${
              viewMode === 'conversation'
                ? 'bg-accent/20 text-accent'
                : 'text-text-3 hover:text-text'
            }`}
          >
            Conversation
          </button>
          <button
            type="button"
            onClick={() => {
              setViewMode('raw');
              setVisibleCount(WINDOW_STEP);
            }}
            className={`rounded px-2.5 py-1 text-xs transition-colors ${
              viewMode === 'raw' ? 'bg-accent/20 text-accent' : 'text-text-3 hover:text-text'
            }`}
          >
            Raw
          </button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <p className="text-sm text-text-3">No lines match &quot;{query}&quot;.</p>
      ) : (
        <div className="space-y-2 font-mono text-sm">
          {visible.map((line, i) =>
            viewMode === 'conversation' ? (
              <TranscriptTurnView key={i} line={line} />
            ) : (
              <RawLine key={i} line={line.src as RawLine} />
            ),
          )}
        </div>
      )}

      {remaining > 0 && (
        <button
          type="button"
          onClick={() => setVisibleCount((c) => c + WINDOW_STEP)}
          className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-2 hover:border-accent hover:text-accent transition-colors"
        >
          Show {Math.min(remaining, WINDOW_STEP)} more ({remaining} hidden)
        </button>
      )}
    </div>
  );
}
