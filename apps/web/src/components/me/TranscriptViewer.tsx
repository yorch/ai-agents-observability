'use client';
import { useEffect, useState } from 'react';

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
  return <p className="whitespace-pre-wrap text-white/80 text-sm leading-relaxed">{block.text}</p>;
}

function ToolUseBlockView({ block }: { block: ToolUseBlock }) {
  const inputJson = JSON.stringify(block.input, null, 2);
  return (
    <details className="rounded border border-brand-500/20 bg-brand-500/5 text-sm">
      <summary className="cursor-pointer px-3 py-1.5 text-brand-400 font-mono select-none list-none flex items-center gap-2">
        <span className="text-white/30">▶</span>
        <span className="text-xs text-white/40">tool</span>
        <span className="font-semibold">{block.name}</span>
      </summary>
      <pre className="px-3 pb-2 pt-1 text-xs text-white/60 overflow-x-auto whitespace-pre-wrap break-words">
        {inputJson}
      </pre>
    </details>
  );
}

function ToolResultBlockView({ block }: { block: ToolResultBlock }) {
  const raw =
    typeof block.content === 'string'
      ? block.content
      : // JSON.stringify returns `undefined` (not a string) for an absent/undefined
        // content field; coalesce so the `.length` access below can't crash the viewer.
        (JSON.stringify(block.content, null, 2) ?? '');
  const isLong = raw.length > 500;
  return (
    <details className="rounded border border-white/10 bg-white/5 text-sm">
      <summary className="cursor-pointer px-3 py-1.5 text-white/40 font-mono select-none list-none flex items-center gap-2">
        <span className="text-white/20">▶</span>
        <span className="text-xs">tool result</span>
        {isLong && <span className="text-white/20 text-xs">({raw.length} chars)</span>}
      </summary>
      <pre className="px-3 pb-2 pt-1 text-xs text-white/50 overflow-x-auto whitespace-pre-wrap break-words max-h-64 overflow-y-auto">
        {isLong ? `${raw.slice(0, 500)}…` : raw}
      </pre>
    </details>
  );
}

function UnknownBlockView({ block }: { block: { type: string; [key: string]: unknown } }) {
  return (
    <pre className="rounded bg-white/5 px-3 py-2 text-xs text-white/30 overflow-x-auto whitespace-pre-wrap break-words">
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
  if (content === undefined || content === null) {
    return null;
  }
  if (typeof content === 'string') {
    return <p className="whitespace-pre-wrap text-white/80 text-sm leading-relaxed">{content}</p>;
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
    <pre className="text-xs text-white/30 whitespace-pre-wrap break-words">
      {JSON.stringify(content)}
    </pre>
  );
}

function TranscriptLine({ line }: { line: Line }) {
  // Handle raw (unparseable) lines
  if (line.raw !== undefined) {
    return (
      <div className="rounded px-3 py-2 bg-white/3 border border-white/5">
        <span className="text-xs text-white/20 mr-2">raw</span>
        <span className="text-xs text-white/30 font-mono">{String(line.raw)}</span>
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
          ? 'bg-white/5'
          : isAssistant
            ? 'bg-brand-500/5 border border-brand-500/10'
            : 'bg-white/3 border border-white/5'
      }`}
    >
      <span className="block text-xs text-white/40 mb-1 capitalize">{effectiveRole}</span>
      {message ? (
        <MessageContent content={message.content} />
      ) : (
        <pre className="text-xs text-white/30 whitespace-pre-wrap break-words">
          {JSON.stringify(line)}
        </pre>
      )}
    </div>
  );
}

export function TranscriptViewer({ apiUrl, sessionId }: { apiUrl?: string; sessionId: string }) {
  const [lines, setLines] = useState<Line[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(apiUrl ?? `/api/me/transcripts/${sessionId}`)
      .then((r) => {
        if (!r.ok) {
          throw new Error(`HTTP ${r.status}`);
        }
        return r.text();
      })
      .then((text) => {
        const parsed = text
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => {
            try {
              return JSON.parse(l) as Line;
            } catch {
              return { raw: l } as Line;
            }
          });
        setLines(parsed);
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to load transcript');
        setLoading(false);
      });
  }, [sessionId]);

  if (loading) {
    return <div className="animate-pulse h-96 bg-white/5 rounded-lg" />;
  }
  if (error) {
    return <p className="text-sm text-red-400">Error: {error}</p>;
  }
  if (lines.length === 0) {
    return <p className="text-sm text-white/40">Transcript is empty.</p>;
  }

  return (
    <div className="space-y-2 font-mono text-sm">
      {lines.map((line, i) => (
        <TranscriptLine key={i} line={line} />
      ))}
    </div>
  );
}
