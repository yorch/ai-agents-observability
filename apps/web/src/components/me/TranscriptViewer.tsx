'use client';
import { useEffect, useMemo, useState } from 'react';

// ── Transcript line types ─────────────────────────────────────────────────────

type TextBlock = { type: 'text'; text: string };
type ToolUseBlock = { type: 'tool_use'; name: string; input: unknown };
type ToolResultBlock = { type: 'tool_result'; content: unknown };
type ContentBlock =
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock
  | { type: string; [key: string]: unknown };

type Message = {
  role?: string;
  content?: string | ContentBlock[];
  [key: string]: unknown;
};

type Line = {
  type?: string;
  message?: Message;
  raw?: string;
  [key: string]: unknown;
};

// ── Content block renderers ───────────────────────────────────────────────────

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

function lineSearchText(line: Line): string {
  if (line.raw !== undefined) {
    return String(line.raw);
  }
  const message = line.message;
  if (!message) {
    return JSON.stringify(line);
  }
  const parts: string[] = [];
  if (message.role) {
    parts.push(message.role);
  }
  if (typeof message.content === 'string') {
    parts.push(message.content);
  } else if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (block.type === 'text') {
        parts.push((block as TextBlock).text);
      } else {
        parts.push(JSON.stringify(block));
      }
    }
  }
  return parts.join(' ');
}

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

function TranscriptLine({ line }: { line: Line }) {
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
        <MessageContent content={message.content} />
      ) : (
        <pre className="text-xs text-text-3 whitespace-pre-wrap break-words">
          {JSON.stringify(line)}
        </pre>
      )}
    </div>
  );
}

function parseLine(raw: string): Line {
  try {
    return JSON.parse(raw) as Line;
  } catch {
    return { raw } as Line;
  }
}

type ParsedLine = { line: Line; search: string };
function toParsed(raw: string): ParsedLine {
  const line = parseLine(raw);
  return { line, search: lineSearchText(line).toLowerCase() };
}

const WINDOW_STEP = 300;

export function TranscriptViewer({
  apiUrl,
  sessionId,
}: {
  apiUrl?: string | undefined;
  sessionId: string;
}) {
  const [lines, setLines] = useState<ParsedLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [visibleCount, setVisibleCount] = useState(WINDOW_STEP);

  const url = apiUrl ?? `/api/me/transcripts/${sessionId}`;

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setLines([]);
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
            setLines(text.trim().split('\n').filter(Boolean).map(toParsed));
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
            setLines((prev) => prev.concat(batch));
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
              pending.push(toParsed(raw));
            }
            nl = buf.indexOf('\n');
          }
          if (pending.length >= 200) {
            flush();
          }
        }
        buf += decoder.decode();
        if (buf.trim()) {
          pending.push(toParsed(buf));
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

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return lines;
    }
    return lines.filter((pl) => pl.search.includes(needle));
  }, [lines, query]);

  if (loading && lines.length === 0) {
    return <div className="animate-pulse h-96 bg-surface rounded-lg" />;
  }
  if (error) {
    return <p className="text-sm text-red-400">Error: {error}</p>;
  }
  if (lines.length === 0) {
    return <p className="text-sm text-text-3">Transcript is empty.</p>;
  }

  const visible = filtered.slice(0, visibleCount);
  const remaining = filtered.length - visible.length;

  return (
    <div className="space-y-3">
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
          {query.trim() ? `${filtered.length} / ${lines.length}` : `${lines.length} lines`}
          {loading ? ' · loading…' : ''}
        </span>
      </div>

      {filtered.length === 0 ? (
        <p className="text-sm text-text-3">No lines match &quot;{query}&quot;.</p>
      ) : (
        <div className="space-y-2 font-mono text-sm">
          {visible.map((pl, i) => (
            <TranscriptLine key={i} line={pl.line} />
          ))}
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
