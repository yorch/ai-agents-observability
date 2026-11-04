'use client';
import { CaretRightIcon } from '@/components/icons';
import { Badge } from '@/components/ui/Badge';
import { cx } from '@/components/ui/cx';
import { fmtTimeUtc } from '@/lib/fmt';
import type {
  ContentBlock,
  ParsedLine,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
} from '@/lib/transcript-parser';

/** Who said what. Driven by the session's agent and owner — never hard-coded. */
export type TranscriptLabels = {
  /** e.g. "Claude Code", "Codex" — from agentDisplayName(session.agentType). */
  assistant: string;
  /** "You" on /me; the owner's name in team/org scope. */
  user: string;
};

export const DEFAULT_TRANSCRIPT_LABELS: TranscriptLabels = { assistant: 'Assistant', user: 'User' };

// Wrap a long unbroken token (a path, a hash, a minified line) inside its
// bubble instead of widening the page.
const WRAP = 'whitespace-pre-wrap [overflow-wrap:anywhere]';

function resultText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  // Results are often `[{type:'text', text}]` — show the text.
  if (Array.isArray(content)) {
    const texts = content
      .map((b) =>
        b && typeof b === 'object' && (b as Record<string, unknown>).type === 'text'
          ? String((b as Record<string, unknown>).text ?? '')
          : null,
      )
      .filter((t): t is string => t !== null);
    if (texts.length === content.length && texts.length > 0) {
      return texts.join('\n');
    }
  }
  return JSON.stringify(content, null, 2) ?? '';
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
    <details className="group min-w-0 rounded border border-border-subtle bg-surface-2 text-sm">
      <summary className="cursor-pointer px-3 py-1.5 select-none list-none flex items-center gap-2 min-w-0">
        <CaretRightIcon
          size={10}
          className="text-text-3 shrink-0 transition-transform group-open:rotate-90"
        />
        <span className="text-xs text-text-3 font-mono shrink-0">tool</span>
        <span className="font-semibold text-text-2 font-mono shrink-0">{block.name}</span>
        {preview && <span className="min-w-0 text-xs text-text-3 truncate">{preview}</span>}
      </summary>
      <pre className="px-3 pb-2 pt-1 text-xs text-text-2 overflow-x-auto whitespace-pre-wrap [overflow-wrap:anywhere]">
        {JSON.stringify(block.input, null, 2)}
      </pre>
    </details>
  );
}

function ToolResultsView({ note, results }: { note?: string; results: ToolResultBlock[] }) {
  return (
    <div className="min-w-0 space-y-1 pl-4 border-l border-border-subtle">
      {results.map((r, i) => {
        const text = resultText(r.content);
        const lines = text ? text.split('\n').length : 0;
        return (
          <details key={i} className="group min-w-0 text-sm">
            <summary className="cursor-pointer text-xs text-text-3 select-none list-none flex items-center gap-1.5 py-0.5 hover:text-text transition-colors">
              <CaretRightIcon
                size={9}
                className="shrink-0 transition-transform group-open:rotate-90"
              />
              <span>{r.toolName ?? 'tool'} result</span>
              <span className="font-mono">
                ({lines.toLocaleString()} line{lines === 1 ? '' : 's'})
              </span>
              {r.isError && <Badge tone="crit">error</Badge>}
            </summary>
            <pre className="mt-1 rounded bg-surface border border-border-subtle px-3 py-2 text-xs text-text-3 overflow-x-auto whitespace-pre-wrap [overflow-wrap:anywhere] max-h-64 overflow-y-auto">
              {text}
            </pre>
          </details>
        );
      })}
      {note && <p className={cx('text-xs text-text-3', WRAP)}>{note}</p>}
    </div>
  );
}

function AssistantBlocks({ blocks }: { blocks: ContentBlock[] }) {
  const items = blocks.filter((b) => b.type === 'text' || b.type === 'tool_use');
  if (items.length === 0) {
    return null;
  }
  return (
    <div className="min-w-0 space-y-2">
      {items.map((block, i) => {
        if (block.type === 'text') {
          const text = (block as TextBlock).text;
          if (!text) {
            return null;
          }
          return (
            <div key={i} className="rounded px-3 py-2 bg-accent-dim border border-accent-line">
              <p className={cx('text-sm text-text-2', WRAP)}>{text}</p>
            </div>
          );
        }
        return <ToolUseView key={i} block={block as ToolUseBlock} />;
      })}
    </div>
  );
}

export function TranscriptTurnView({
  labels = DEFAULT_TRANSCRIPT_LABELS,
  line,
}: {
  labels?: TranscriptLabels;
  line: ParsedLine;
}) {
  if (line.kind === 'user-message') {
    return (
      <div className="min-w-0 space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-text-2">{labels.user}</span>
          {line.timestamp && (
            <span className="text-xs text-text-3">{fmtTimeUtc(line.timestamp)}</span>
          )}
        </div>
        <div className="rounded px-3 py-2 bg-surface border border-border-subtle">
          <p className={cx('text-sm text-text-2', WRAP)}>{line.content}</p>
        </div>
      </div>
    );
  }

  if (line.kind === 'assistant-turn') {
    return (
      <div className="min-w-0 space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-semibold text-accent">{labels.assistant}</span>
          {line.model && <span className="text-xs text-text-3 font-mono">{line.model}</span>}
          {line.timestamp && (
            <span className="text-xs text-text-3">{fmtTimeUtc(line.timestamp)}</span>
          )}
          {line.usage && line.usage.outputTokens > 0 && (
            <span className="text-xs text-text-3 font-mono">
              {line.usage.outputTokens.toLocaleString()} tok
            </span>
          )}
        </div>
        <AssistantBlocks blocks={line.blocks} />
      </div>
    );
  }

  if (line.kind === 'tool-results') {
    return <ToolResultsView results={line.results} {...(line.note && { note: line.note })} />;
  }

  return null;
}
