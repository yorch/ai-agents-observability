'use client';

import {
  RUBRIC_OUTCOME_QUESTION,
  RUBRIC_SHAPE_QUESTION,
  type RubricOutcome,
  type RubricShape,
} from '@ai-agents-observability/schemas';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { submitSessionFeedback } from '@/app/me/sessions/[id]/actions';
import { ThumbsDownIcon, ThumbsUpIcon } from '@/components/icons';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Field, Select, Textarea } from '@/components/ui/Field';
import { useActionResult } from '@/lib/use-action-result';

type Sentiment = 'up' | 'down' | null;

/**
 * Owner feedback on a session (R11) extended into the versioned self-label
 * rubric (P13-005): a quick thumbs, an optional note, and two questions whose
 * answers become `scores` rows with `source: HUMAN`.
 *
 * ── The blinding rule — do not remove this in a refactor ────────────────────
 *
 * This component must never render the computed values the rubric exists to
 * check: no `shape_label` beside the shape question, no `friction_score` beside
 * the outcome question, and no wording that hints at either. That is why its
 * props carry the *session id* and the developer's own prior answers and nothing
 * else — the session row is deliberately not passed in, so the computed fields
 * are not even in scope here.
 *
 * The reason is the whole point of collecting the label. Shown the classifier's
 * answer first, a developer anchors on it, and what gets stored is agreement
 * with the scorer rather than an independent account of the session. The label
 * would then "validate" the scorer by construction, which is worse than having
 * no label at all: it produces a confident accuracy figure that measures
 * nothing. `SessionDetailHeader` renders the computed signals further down the
 * page; keeping them out of *this card* is the invariant.
 *
 * Enforced by `apps/web/test/session-rubric.test.ts`, which scans this file and
 * the page that mounts it.
 */
export function SessionFeedbackForm({
  sessionId,
  initialSentiment,
  initialNote,
  initialShape,
  initialOutcome,
}: {
  initialNote: string | null;
  initialOutcome: RubricOutcome | null;
  initialSentiment: Sentiment;
  initialShape: RubricShape | null;
  sessionId: string;
}) {
  const [sentiment, setSentiment] = useState<Sentiment>(initialSentiment);
  const [note, setNote] = useState(initialNote ?? '');
  const [shape, setShape] = useState<RubricShape | ''>(initialShape ?? '');
  const [outcome, setOutcome] = useState<RubricOutcome | ''>(initialOutcome ?? '');
  const { error, isPending, reset, run, saved } = useActionResult();

  function save(next: {
    outcome?: RubricOutcome | '';
    sentiment?: Sentiment;
    shape?: RubricShape | '';
  }) {
    const fd = new FormData();
    fd.set('sessionId', sessionId);
    fd.set('sentiment', (next.sentiment !== undefined ? next.sentiment : sentiment) ?? '');
    fd.set('note', note);
    fd.set('rubricShape', next.shape !== undefined ? next.shape : shape);
    fd.set('rubricOutcome', next.outcome !== undefined ? next.outcome : outcome);
    run(() => submitSessionFeedback(fd));
  }

  function pick(value: 'up' | 'down') {
    const next = sentiment === value ? null : value;
    setSentiment(next);
    reset();
    save({ sentiment: next });
  }

  const btn = (value: 'up' | 'down', label: ReactNode) => {
    const active = sentiment === value;
    const activeCls = value === 'up' ? 'border-good-line text-good' : 'border-crit-line text-crit';
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
    <Card contentClassName="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-4">
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

      {/*
        The rubric. Prompt text and options come from the versioned definition in
        packages/schemas — reworded here, they would silently redefine what every
        previously-stored answer meant.
      */}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field htmlFor="rubric-shape" label={RUBRIC_SHAPE_QUESTION.prompt}>
          <Select
            id="rubric-shape"
            size="sm"
            value={shape}
            disabled={isPending}
            onChange={(e) => {
              const next = e.target.value as RubricShape | '';
              setShape(next);
              reset();
              save({ shape: next });
            }}
          >
            <option value="">Skip</option>
            {RUBRIC_SHAPE_QUESTION.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field htmlFor="rubric-outcome" label={RUBRIC_OUTCOME_QUESTION.prompt}>
          <Select
            id="rubric-outcome"
            size="sm"
            value={outcome}
            disabled={isPending}
            onChange={(e) => {
              const next = e.target.value as RubricOutcome | '';
              setOutcome(next);
              reset();
              save({ outcome: next });
            }}
          >
            <option value="">Skip</option>
            {RUBRIC_OUTCOME_QUESTION.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <Textarea
        className="w-full"
        value={note}
        onChange={(e) => {
          setNote(e.target.value);
          reset();
        }}
        aria-label="Session note"
        placeholder="Optional note (what worked, what didn't)…"
        rows={2}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" onClick={() => save({})} disabled={isPending}>
          {isPending ? 'Saving…' : 'Save note'}
        </Button>
        {saved && !isPending && <span className="text-xs text-text-3">Saved</span>}
        {error && !isPending && (
          <span role="alert" className="text-xs text-crit">
            {error}
          </span>
        )}
        <span className="text-xs text-text-3">Only you can see this.</span>
      </div>
    </Card>
  );
}
