'use client';
import { useEffect, useState } from 'react';

type Line = { role?: string; content?: string; type?: string; message?: unknown; [key: string]: unknown };

function TranscriptLine({ line }: { line: Line }) {
  const role = line.type === 'user' ? 'user' : 'assistant';
  return (
    <div className={`rounded px-3 py-2 ${role === 'user' ? 'bg-white/5' : 'bg-brand-500/5 border border-brand-500/10'}`}>
      <span className="text-xs text-white/40 mr-2">{role}</span>
      <span>
        {typeof line.message === 'object'
          ? JSON.stringify(line.message).slice(0, 200)
          : String(line.content ?? '')}
      </span>
    </div>
  );
}

export function TranscriptViewer({ sessionId }: { sessionId: string }) {
  const [lines, setLines] = useState<Line[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/me/transcripts/${sessionId}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
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

  if (loading) return <div className="animate-pulse h-96 bg-white/5 rounded-lg" />;
  if (error) return <p className="text-sm text-red-400">Error: {error}</p>;
  if (lines.length === 0) return <p className="text-sm text-white/40">Transcript is empty.</p>;

  return (
    <div className="space-y-2 font-mono text-sm">
      {lines.map((line, i) => (
        <TranscriptLine key={i} line={line} />
      ))}
    </div>
  );
}
