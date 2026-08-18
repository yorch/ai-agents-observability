'use client';

import type { MouseEvent, ReactNode } from 'react';
import { Button, type ButtonSize, type ButtonVariant } from './Button';

/**
 * The confirm guard itself, for destructive submits that are not `Button`s
 * (e.g. text affordances like the share popover's Revoke). ConfirmButton uses
 * this too, so replacing the native confirm() with a styled dialog later is
 * one edit for every call site.
 */
export function confirmSubmit(message: string) {
  return (e: MouseEvent<HTMLButtonElement>) => {
    if (!window.confirm(message)) {
      e.preventDefault();
    }
  };
}

/**
 * A submit button whose form action only fires after a native confirm().
 * For destructive one-click server-action forms (revoke, delete, bulk
 * approve); a styled dialog primitive can replace the confirm() later without
 * touching call sites.
 */
export function ConfirmButton({
  children,
  confirmMessage,
  size,
  variant = 'danger',
}: {
  children: ReactNode;
  confirmMessage: string;
  size?: ButtonSize;
  variant?: ButtonVariant;
}) {
  return (
    <Button
      type="submit"
      variant={variant}
      {...(size ? { size } : {})}
      onClick={confirmSubmit(confirmMessage)}
    >
      {children}
    </Button>
  );
}
