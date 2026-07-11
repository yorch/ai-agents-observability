'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import type { ShareResult } from '@/app/me/sessions/[id]/actions';
import { revokeShare, shareSession } from '@/app/me/sessions/[id]/actions';
import { ArrowRightIcon } from '@/components/icons';

type ActiveShare = { expiresAt: Date; granteeEmail: string | null; id: string };

function formatExpiry(expiresAt: Date): string {
  const ms = expiresAt.getTime() - Date.now();
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) {
    return 'expires soon';
  }
  if (hours < 24) {
    return `${hours}h left`;
  }
  return `${Math.floor(hours / 24)}d left`;
}

export function ShareSessionButton({
  activeShares,
  sessionId,
}: {
  activeShares: ActiveShare[];
  sessionId: string;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastShared, setLastShared] = useState<{ email: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [isPending, startTransition] = useTransition();
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on click-outside and Escape.
  useEffect(() => {
    if (!open) {
      return;
    }
    function onOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onOutside);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onOutside);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  function handleShare(formData: FormData) {
    setError(null);
    startTransition(async () => {
      const result: ShareResult = await shareSession(formData);
      if ('error' in result) {
        setError(result.error);
      } else {
        setLastShared({ email: result.email });
      }
    });
  }

  async function copyLink() {
    const url = `${window.location.origin}/org/sessions/${sessionId}`;
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const count = activeShares.length;

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-text-2 hover:border-accent hover:text-accent transition-colors"
      >
        Share
        {count > 0 && (
          <span className="rounded-full bg-accent/20 px-1.5 py-0.5 text-[10px] font-medium text-accent leading-none">
            {count}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Share session"
          className="absolute right-0 top-full mt-2 z-50 w-72 rounded-lg border border-border bg-surface shadow-xl"
        >
          <div className="px-4 pt-3 pb-2">
            <p className="text-xs font-semibold uppercase tracking-widest text-text-3">
              Share session
            </p>
          </div>

          {/* Active shares list */}
          {count > 0 && (
            <div className="border-t border-border px-4 py-2 space-y-1">
              {activeShares.map((share) => (
                <div key={share.id} className="flex items-center justify-between gap-2 py-0.5">
                  <div className="min-w-0">
                    <p className="truncate text-xs text-text">{share.granteeEmail ?? '—'}</p>
                    <p className="text-[10px] text-text-3">{formatExpiry(share.expiresAt)}</p>
                  </div>
                  <form action={revokeShare}>
                    <input type="hidden" name="grantId" value={share.id} />
                    <input type="hidden" name="sessionId" value={sessionId} />
                    <button
                      type="submit"
                      title="Revoke access"
                      className="rounded px-1.5 py-0.5 text-[10px] text-text-3 hover:bg-red-500/10 hover:text-red-400 transition-colors"
                    >
                      Revoke
                    </button>
                  </form>
                </div>
              ))}
            </div>
          )}

          {/* Success notice */}
          {lastShared && (
            <div className="border-t border-border px-4 py-3 space-y-2">
              <p className="text-xs text-green-400">Shared with {lastShared.email}</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 truncate rounded bg-surface-2 px-2 py-1 text-[10px] text-text-3">
                  /org/sessions/{sessionId}
                </code>
                <button
                  type="button"
                  onClick={copyLink}
                  className="shrink-0 rounded border border-border px-2 py-1 text-[10px] text-text-2 hover:border-accent hover:text-accent transition-colors"
                >
                  {copied ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <button
                type="button"
                onClick={() => {
                  setLastShared(null);
                  setError(null);
                }}
                className="inline-flex items-center gap-1 text-[10px] text-text-3 hover:text-text transition-colors"
              >
                Share with another <ArrowRightIcon size={11} />
              </button>
            </div>
          )}

          {/* New share form */}
          {!lastShared && (
            <div className="border-t border-border px-4 py-3">
              {error && <p className="mb-2 text-xs text-red-400">{error}</p>}
              <form action={handleShare} className="space-y-2">
                <input type="hidden" name="sessionId" value={sessionId} />
                <input
                  type="email"
                  name="email"
                  required
                  placeholder="colleague@example.com"
                  className="w-full rounded border border-border bg-surface-2 px-2 py-1.5 text-xs placeholder:text-text-3 focus:border-accent focus:outline-none"
                />
                <div className="flex items-center gap-2">
                  <select
                    name="days"
                    defaultValue="7"
                    className="flex-1 rounded border border-border bg-surface-2 px-2 py-1.5 text-xs text-text-2"
                  >
                    <option value="1">Expires in 1 day</option>
                    <option value="7">Expires in 7 days</option>
                    <option value="30">Expires in 30 days</option>
                  </select>
                  <button
                    type="submit"
                    disabled={isPending}
                    className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-bg hover:opacity-90 disabled:opacity-50 transition-opacity"
                  >
                    {isPending ? '…' : 'Share'}
                  </button>
                </div>
              </form>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
