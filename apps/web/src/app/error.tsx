'use client';

import { useEffect } from 'react';
import { Button } from '@/components/ui/Button';
import { useDict } from '@/i18n/provider';

export default function GlobalError({ error, reset }: { error: Error; reset: () => void }) {
  const dict = useDict();
  useEffect(() => {
    // Surface to the browser console; production logging is handled server-side.
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto max-w-md space-y-4 py-16 text-center">
      <h1 className="font-display text-xl font-semibold tracking-tight text-text">
        {dict.common.somethingWentWrong}
      </h1>
      <Button variant="secondary" size="sm" onClick={reset}>
        {dict.common.tryAgain}
      </Button>
    </div>
  );
}
