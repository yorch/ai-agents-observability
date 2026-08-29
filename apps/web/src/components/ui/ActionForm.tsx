'use client';

import type { ReactNode } from 'react';
import { useActionState } from 'react';
import { useDict } from '@/i18n/provider';
import type { ActionResult } from '@/lib/action-result-types';

/**
 * A form around a server action that returns `ActionResult`, rendering the
 * outcome inline — success in `good`, rejection in `crit` — where the plain
 * `<form action={…}>` swallowed both. Children stay server-rendered.
 */
export function ActionForm({
  action,
  children,
  className,
}: {
  action: (formData: FormData) => Promise<ActionResult>;
  children: ReactNode;
  className?: string;
}) {
  const dict = useDict();
  const [state, formAction, isPending] = useActionState(
    async (_prev: ActionResult | null, formData: FormData) => action(formData),
    null,
  );

  return (
    <form action={formAction} className={className}>
      {children}
      {!isPending && state && !state.ok && (
        <p role="alert" className="basis-full text-xs text-crit">
          {state.error}
        </p>
      )}
      {!isPending && state?.ok && (
        <p role="status" className="basis-full text-xs text-good">
          {state.message ?? dict.common.saved}
        </p>
      )}
    </form>
  );
}
