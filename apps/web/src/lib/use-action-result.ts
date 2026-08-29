'use client';

import { useState, useTransition } from 'react';
import { useDict } from '@/i18n/provider';
import type { ActionResult } from './action-result-types';

/**
 * Result plumbing for client components that call an `ActionResult` action
 * programmatically rather than via `<form action>` (where `ActionForm`
 * applies): one implementation of pending/saved/error state and the network
 * catch, instead of each form hand-rolling the same transition block.
 */
export function useActionResult() {
  const [isPending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dict = useDict();

  function run(action: () => Promise<ActionResult>) {
    startTransition(async () => {
      try {
        const result = await action();
        if (result.ok) {
          setError(null);
          setSaved(true);
        } else {
          setError(result.error);
          setSaved(false);
        }
      } catch {
        setError(dict.actionResult.networkError);
        setSaved(false);
      }
    });
  }

  /** Clears both flags — call when the user edits after a save attempt. */
  function reset() {
    setSaved(false);
    setError(null);
  }

  return { error, isPending, reset, run, saved };
}
