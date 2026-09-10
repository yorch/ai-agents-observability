'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';

export function DeleteDataButton() {
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const doneRef = useRef<HTMLParagraphElement>(null);

  // On success this component REPLACES itself, so the button holding focus
  // unmounts and focus falls to <body>: nothing is announced, and the next Tab
  // restarts from the top of the document. For the confirmation of an
  // irreversible request that is the worst moment to lose someone.
  //
  // role="status" announces it; tabIndex={-1} plus this focus() makes the
  // confirmation the user's new position, so Tab continues from here. The
  // element is only focusable programmatically — it never enters the tab order.
  useEffect(() => {
    if (done) {
      doneRef.current?.focus();
    }
  }, [done]);

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
      <p
        ref={doneRef}
        role="status"
        tabIndex={-1}
        className="text-sm text-text-2 outline-offset-2 focus-visible:outline-2 focus-visible:outline-accent"
      >
        Deletion request received. Your data will be removed within 30 days.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <Button variant="danger" onClick={handleClick} disabled={pending}>
        {pending ? 'Requesting…' : 'Delete my data'}
      </Button>
      {/* Was rendered with no role, so a failed deletion request was silent —
          on a control whose whole purpose is an irreversible action. */}
      {error && (
        <p role="alert" className="text-sm text-crit">
          {error}
        </p>
      )}
    </div>
  );
}
