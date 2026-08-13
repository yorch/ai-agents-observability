'use client';

import type { ReactNode } from 'react';
import { Button, type ButtonSize, type ButtonVariant } from './Button';

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
      onClick={(e) => {
        if (!window.confirm(confirmMessage)) {
          e.preventDefault();
        }
      }}
    >
      {children}
    </Button>
  );
}
