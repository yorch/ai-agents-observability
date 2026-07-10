'use client';
import { CaretRightIcon } from '@/components/icons';
import type {
  ContentBlock,
  ParsedLine,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
} from '@/lib/transcript-parser';

function formatTime(ts: string): string {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function getInputPreview(input: unknown): string {
  if (!input || typeof input !== 'object') {
    return '';
  }
  const obj = input as Record<string, unknown>;
  const val = obj.file_path ?? obj.command ?? obj.path ?? obj.query ?? obj.description ?? '';
  if (typeof val !== 'string') {
    return '';
  }
  return val.length > 60 ? `${val.slice(0, 60)}…` : val;
}

function ToolUseView({ block }: { block: ToolUseBlock }) {
  const preview = getInputPreview(block.input);
  return (
    <details open className="group rounded border border-accent/20 bg-accent/5 text-sm">
      <summary className="cursor-pointer px-3 py-1.5 select-none list-none flex items-center gap-2 min-w-0">
        <CaretRightIcon
          size={10}
          className="text-text-3 shrink-0 transition-transform group-open:rotate-90"
        />
        <span className="text-xs text-text-3 font-mono shrink-0">tool</span>
        <span className="font-semibold text-accent font-mono shrink-0">{block.name}</span>
        {preview && <span className="text-xs text-text-3 truncate">{preview}</span>}
      </summary>
      <pre className="px-3 pb-2 pt-1 text-xs text-text-2 overflow-x-auto whitespace-pre-wrap break-words">
        {JSON.stringify(block.input, null, 2)}
      </pre>
    </details>
  );
}

function ToolResultsView({ results }: { results: ToolResultBlock[] }) {
  return (
    <div className="space-y-1 pl-4 border-l border-border-subtle">
      {results.map((r, i) => (
        <details key={i} className="group text-sm">
          <summary className="cursor-pointer text-xs text-text-3 select-none list-none flex items-center gap-1.5 py-0.5 hover:text-text transition-colors">
            <CaretRightIcon
              size={9}
              className="shrink-0 transition-transform group-open:rotate-90"
            />
            <span>{r.toolName ?? 'tool'} result</span>
          </summary>
          <pre className="mt-1 rounded bg-surface border border-border-subtle px-3 py-2 text-xs text-text-3 overflow-x-auto whitespace-pre-wrap break-words max-h-64 overflow-y-auto">
            {typeof r.content === 'string' ? r.content : JSON.stringify(r.content, null, 2)}
          </pre>
        </details>
      ))}
    </div>
  );
}

function AssistantBlocks({ blocks }: { blocks: ContentBlock[] }) {
  const items = blocks.filter((b) => b.type === 'text' || b.type === 'tool_use');
  if (items.length === 0) {
    return null;
  }
  return (
    <div className="space-y-2">
      {items.map((block, i) => {
        if (block.type === 'text') {
          const text = (block as TextBlock).text;
          if (!text) {
            return null;
          }
          return (
            <div key={i} className="rounded px-3 py-2 bg-accent/5 border border-accent/15">
              <p className="text-sm text-text-2 whitespace-pre-wrap">{text}</p>
            </div>
          );
        }
        return <ToolUseView key={i} block={block as ToolUseBlock} />;
      })}
    </div>
  );
}

export function TranscriptTurnView({ line }: { line: ParsedLine }) {
  if (line.kind === 'user-message') {
    return (
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-text-2">You</span>
          {line.timestamp && (
            <span className="text-xs text-text-3">{formatTime(line.timestamp)}</span>
          )}
        </div>
        <div className="rounded px-3 py-2 bg-surface border border-border-subtle">
          <p className="text-sm text-text-2 whitespace-pre-wrap">{line.content}</p>
        </div>
      </div>
    );
  }

  if (line.kind === 'assistant-turn') {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-semibold text-accent">Claude</span>
          {line.model && <span className="text-xs text-text-3 font-mono">{line.model}</span>}
          {line.timestamp && (
            <span className="text-xs text-text-3">{formatTime(line.timestamp)}</span>
          )}
          {line.usage && line.usage.outputTokens > 0 && (
            <span className="text-xs text-text-3 font-mono">{line.usage.outputTokens} tok</span>
          )}
        </div>
        <AssistantBlocks blocks={line.blocks} />
      </div>
    );
  }

  if (line.kind === 'tool-results') {
    return <ToolResultsView results={line.results} />;
  }

  return null;
}
