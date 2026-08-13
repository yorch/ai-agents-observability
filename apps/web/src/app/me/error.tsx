'use client';

import { useEffect } from 'react';
import { Button } from '@/components/ui/Button';

// Scoped boundary: a failed org query degrades this page while the rail and
// shell stay up, instead of blowing away the whole app frame.
export default function SectionError({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto max-w-md space-y-4 py-16 text-center">
      <h1 className="font-display text-xl font-semibold tracking-tight text-text">
        This page failed to load.
      </h1>
      <p className="text-sm text-text-2">A query behind this view errored. Try again.</p>
      <Button variant="secondary" size="sm" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
