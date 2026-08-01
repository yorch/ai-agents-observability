'use client';

import { useEffect } from 'react';

export default function GlobalError({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => {
    // Surface to the browser console; production logging is handled server-side.
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto max-w-md space-y-4 py-16 text-center">
      <h1 className="font-display text-xl font-semibold">Something went wrong.</h1>
      <button
        type="button"
        onClick={reset}
        className="rounded-md border border-border-strong px-3 py-1 text-sm hover:bg-surface-2"
      >
        Try again
      </button>
    </div>
  );
}
