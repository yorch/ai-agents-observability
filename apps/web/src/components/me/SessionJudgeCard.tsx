import { Badge, type BadgeTone, Card } from '@/components/ui';
import type { JudgeScoreRow } from '@/lib/judge-queries';

/**
 * Owner-only display of judge output for one session (P13-009).
 *
 * Rendered on `/me/sessions/[id]` and nowhere else. Two presentation rules that
 * are guardrails rather than styling:
 *
 *  - **No score, no rank.** The labels are shown as words, not a number and not
 *    a position relative to anyone. There is nothing here to sort a team by.
 *  - **The caveat travels with the number.** Until P13-010 measures the judge
 *    against a gold set, this is an unvalidated opinion, and an unvalidated
 *    number rendered without its status is exactly how it acquires authority it
 *    has not earned.
 */

const COMPLETION_LABELS: Record<string, string> = {
  no: 'Did not accomplish the task',
  partly: 'Partly accomplished the task',
  unclear: 'Not clear from the transcript',
  yes: 'Accomplished the task',
};

const COHERENCE_LABELS: Record<string, string> = {
  coherent: 'Approach held together',
  incoherent: 'Approach thrashed',
  mixed: 'Approach mostly held, with detours',
  unclear: 'Not clear from the transcript',
};

// Neutral for "unclear" — an honest non-answer is not a bad outcome.
const LABEL_TONES: Record<string, BadgeTone> = {
  coherent: 'good',
  incoherent: 'crit',
  mixed: 'warn',
  no: 'crit',
  partly: 'warn',
  unclear: 'neutral',
  yes: 'good',
};

const DIMENSION_TITLES: Record<string, string> = {
  judge_plan_coherence: 'Plan coherence',
  judge_task_completion: 'Task completion',
};

function describe(scorerName: string, label: string): string {
  const map = scorerName === 'judge_task_completion' ? COMPLETION_LABELS : COHERENCE_LABELS;
  return map[label] ?? label;
}

export function SessionJudgeCard({ rows }: { rows: JudgeScoreRow[] }) {
  // Deliberately renders nothing rather than a `CardEmpty`, which is the one
  // place in this app that is right. The judge is off by default and opt-in per
  // developer, so on almost every session there is no evaluation and never will
  // be: an empty state here would advertise a dormant feature on every session
  // page in the product. The convention's "never render nothing for an empty
  // result" is about a section the reader expects to be populated — this is a
  // section that only exists once someone has turned it on.
  if (rows.length === 0) {
    return null;
  }

  // Rows are ordered newest scorer version first; only the current judge is
  // shown. Older versions stay in `scores` for calibration, not for display —
  // two judges disagreeing on one page is a research artifact, not a feature.
  const currentVersion = rows[0]?.scorerVersion;
  const current = rows.filter((r) => r.scorerVersion === currentVersion);
  const provenance = current[0];

  return (
    <Card
      title="Automated evaluation"
      caption="Visible only to you — produced because you opted in under Settings → Privacy"
      contentClassName="space-y-4"
    >
      <div className="space-y-3">
        {current.map((row) => (
          <div key={row.scorerName} className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-text">
                {DIMENSION_TITLES[row.scorerName] ?? row.scorerName}
              </p>
              <p className="mt-0.5 text-xs text-text-2">{describe(row.scorerName, row.label)}</p>
            </div>
            <Badge tone={LABEL_TONES[row.label] ?? 'neutral'}>{row.label}</Badge>
          </div>
        ))}
      </div>

      <p className="text-xs text-text-3">
        This label has not been validated against real outcomes yet, so treat it as one opinion
        rather than a measurement. It is not shown to your team or to org admins, and it feeds no
        score, recommendation, or alert.
        {provenance?.model ? ` Judged by ${provenance.model}` : ''}
        {provenance ? ` (scorer version ${provenance.scorerVersion}).` : ''}
      </p>
    </Card>
  );
}
