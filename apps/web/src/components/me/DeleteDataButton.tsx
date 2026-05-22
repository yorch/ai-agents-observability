'use client';

import { useState } from 'react';

export function DeleteDataButton() {
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    if (!window.confirm('Are you sure you want to delete all your data? This cannot be undone.')) {
      return;
    }
    setPending(true);
    setError(null);
    try {
      const res = await fetch('/api/me/delete', {
        body: JSON.stringify({ reason: 'user_requested' }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      });
      if (res.ok) {
        setDone(true);
      } else {
        setError('Failed to submit deletion request. Please try again.');
      }
    } catch {
      setError('Network error. Please check your connection and try again.');
    } finally {
      setPending(false);
    }
  }

  if (done) {
    return (
      <p className="text-sm text-white/70">
        Deletion request received. Your data will be removed within 30 days.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={handleClick}
        disabled={pending}
        className="rounded-md border border-red-500/50 bg-red-500/10 px-4 py-2 text-sm font-medium text-red-400 hover:bg-red-500/20 transition-colors disabled:opacity-50"
      >
        {pending ? 'Requesting…' : 'Delete my data'}
      </button>
      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}
