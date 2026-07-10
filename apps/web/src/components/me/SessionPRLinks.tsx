'use client';

import { useState, useTransition } from 'react';

import { linkSessionPR, unlinkSessionPR } from '@/app/me/sessions/[id]/actions';
import { JiraLink } from '@/components/JiraLink';

export type SessionPRLinkItem = {
  linkSource: string;
  prNumber: number;
  prState: string;
  prTitle: string | null;
};

const SOURCE_LABELS: Record<string, string> = {
  MANUAL: 'manual',
  SESSION_START: 'auto',
  WEBHOOK_RECONCILE: 'reconciled',
};

// Correlation panel on the own-session detail page: linked PRs (with how the
// link was made), the session's Jira key, and a manual link/unlink escape
// hatch for PRs the automatic heuristics missed.
export function SessionPRLinks({
  canLink,
  jiraBase,
  jiraKey,
  links,
  repoName,
  sessionId,
}: {
  canLink: boolean;
  jiraBase: string | null;
  jiraKey: string | null;
  links: SessionPRLinkItem[];
  repoName: string | null;
  sessionId: string;
}) {
  const [prNumber, setPrNumber] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function submit(action: typeof linkSessionPR, prValue: string, onSuccess?: () => void): void {
    const fd = new FormData();
    fd.set('sessionId', sessionId);
    fd.set('prNumber', prValue);
    setError(null);
    startTransition(async () => {
      const result = await action(fd);
      if ('error' in result) {
        setError(result.error);
      } else {
        onSuccess?.();
      }
    });
  }

  const add = () => submit(linkSessionPR, prNumber.trim(), () => setPrNumber(''));
  const remove = (pr: number) => submit(unlinkSessionPR, String(pr));

  return (
    <div className="rounded-lg border border-border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">Pull requests &amp; ticket</h2>
        {jiraKey ? (
          <span className="text-sm">
            <JiraLink jiraBase={jiraBase} jiraKey={jiraKey} plainClassName="text-text-3" />
          </span>
        ) : null}
      </div>

      {links.length === 0 ? (
        <p className="text-sm text-text-3">No pull requests linked to this session yet.</p>
      ) : (
        <ul className="space-y-1">
          {links.map((link) => (
            <li key={link.prNumber} className="flex items-center gap-2 text-sm">
              <span className="text-text">
                #{link.prNumber}
                {repoName ? <span className="text-text-3"> · {repoName}</span> : null}
              </span>
              {link.prTitle ? <span className="truncate text-text-3">{link.prTitle}</span> : null}
              <span className="rounded border border-border px-1.5 py-0.5 text-xs text-text-3">
                {SOURCE_LABELS[link.linkSource] ?? link.linkSource.toLowerCase()}
              </span>
              <span className="text-xs text-text-3">{link.prState.toLowerCase()}</span>
              {link.linkSource === 'MANUAL' ? (
                <button
                  type="button"
                  onClick={() => remove(link.prNumber)}
                  disabled={isPending}
                  className="text-xs text-text-3 hover:text-red-300 transition-colors"
                >
                  remove
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {canLink ? (
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={1}
            value={prNumber}
            onChange={(e) => setPrNumber(e.target.value)}
            placeholder="PR number"
            className="w-32 rounded-md border border-border bg-transparent px-2 py-1 text-sm"
          />
          <button
            type="button"
            onClick={add}
            disabled={isPending || prNumber.trim() === ''}
            className="rounded-md border border-border px-3 py-1 text-sm text-text-3 hover:text-text transition-colors disabled:opacity-50"
          >
            Link PR
          </button>
        </div>
      ) : (
        <p className="text-xs text-text-3">
          This session has no repository context, so PRs cannot be linked manually.
        </p>
      )}

      {error ? <p className="text-sm text-red-300">{error}</p> : null}
    </div>
  );
}
