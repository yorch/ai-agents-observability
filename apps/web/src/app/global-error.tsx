'use client';

import { useEffect } from 'react';
import { Button } from '@/components/ui/Button';

import '../styles/globals.css';

/**
 * Last-resort boundary: catches throws from the root layout itself (which does
 * live DB work before rendering), where `app/error.tsx` cannot reach. Must
 * render its own <html>/<body>; the imported stylesheet keeps it on-theme
 * instead of Next's unstyled crash page.
 */
export default function GlobalError({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body className="bg-bg font-body text-text">
        <div className="mx-auto max-w-md space-y-4 py-24 text-center">
          <h1 className="font-display text-xl font-semibold tracking-tight">
            Something went wrong.
          </h1>
          <p className="text-sm text-text-2">
            The app could not load. This usually means the database is unreachable — try again in a
            moment.
          </p>
          <Button variant="secondary" onClick={reset}>
            Try again
          </Button>
        </div>
      </body>
    </html>
  );
}
