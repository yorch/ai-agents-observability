'use client';

import type { ReactNode } from 'react';
import { useState, useTransition } from 'react';
import { submitSessionFeedback } from '@/app/me/sessions/[id]/actions';
import { ThumbsDownIcon, ThumbsUpIcon } from '@/components/icons';

type Sentiment = 'up' | 'down' | null;

// R11: owner feedback on a session — a quick thumbs + optional note. The ground
// truth that calibrates the friction/autonomy signals.
export function SessionFeedbackForm({
  sessionId,
  initialSentiment,
  initialNote,
}: {
  initialNote: string | null;
  initialSentiment: Sentiment;
  sessionId: string;
}) {
  const [sentiment, setSentiment] = useState<Sentiment>(initialSentiment);
  const [note, setNote] = useState(initialNote ?? '');
  const [saved, setSaved] = useState(false);
  const [isPending, startTransition] = useTransition();

  function save(next: Sentiment) {
    const fd = new FormData();
    fd.set('sessionId', sessionId);
    fd.set('sentiment', next ?? '');
    fd.set('note', note);
    startTransition(async () => {
      await submitSessionFeedback(fd);
      setSaved(true);
    });
  }

  function pick(value: 'up' | 'down') {
    const next = sentiment === value ? null : value;
    setSentiment(next);
    setSaved(false);
    save(next);
  }

  const btn = (value: 'up' | 'down', label: ReactNode) => {
    const active = sentiment === value;
    const activeCls =
      value === 'up' ? 'border-emerald-500/60 text-emerald-300' : 'border-red-500/60 text-red-300';
    return (
      <button
        type="button"
        onClick={() => pick(value)}
        disabled={isPending}
        className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1 text-sm transition-colors ${
          active ? activeCls : 'border-border text-text-3 hover:text-text'
        }`}
      >
        {label}
      </button>
    );
  };

  return (
    <div className="rounded-lg border border-border bg-surface p-4 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-text">Was this session's work good?</p>
        <div className="flex gap-2">
          {btn(
            'up',
            <>
              <ThumbsUpIcon /> Good
            </>,
          )}
          {btn(
            'down',
            <>
              <ThumbsDownIcon /> Needs work
            </>,
          )}
        </div>
      </div>
      <textarea
        value={note}
        onChange={(e) => {
          setNote(e.target.value);
          setSaved(false);
        }}
        placeholder="Optional note (what worked, what didn't)…"
        rows={2}
        className="w-full rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text focus:border-accent focus:outline-none"
      />
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => save(sentiment)}
          disabled={isPending || sentiment === null}
          className="rounded-md bg-accent px-3 py-1 text-sm font-semibold text-bg hover:opacity-90 disabled:opacity-40"
        >
          {isPending ? 'Saving…' : 'Save note'}
        </button>
        {saved && !isPending && <span className="text-xs text-text-3">Saved</span>}
      </div>
    </div>
  );
}
