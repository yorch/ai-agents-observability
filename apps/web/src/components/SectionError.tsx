'use client';

import { useEffect } from 'react';
import { Button } from '@/components/ui/Button';
import { useDict } from '@/i18n/provider';

// Scoped boundary shared by the section-level error files: a failed query
// degrades the page while the rail and shell stay up, instead of blowing away
// the whole app frame.
export function SectionError({ error, reset }: { error: Error; reset: () => void }) {
  const dict = useDict();
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto max-w-md space-y-4 py-16 text-center">
      <h1 className="font-display text-xl font-semibold tracking-tight text-text">
        {dict.errorBoundary.title}
      </h1>
      <p className="text-sm text-text-2">{dict.errorBoundary.description}</p>
      <Button variant="secondary" size="sm" onClick={reset}>
        {dict.errorBoundary.retryButton}
      </Button>
    </div>
  );
}
