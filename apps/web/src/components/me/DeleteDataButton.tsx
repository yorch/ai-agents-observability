'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';

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
      <p className="text-sm text-text-2">
        Deletion request received. Your data will be removed within 30 days.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <Button variant="danger" onClick={handleClick} disabled={pending}>
        {pending ? 'Requesting…' : 'Delete my data'}
      </Button>
      {error && <p className="text-sm text-crit">{error}</p>}
    </div>
  );
}
