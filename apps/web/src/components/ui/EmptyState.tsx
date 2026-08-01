import type { ReactNode } from 'react';

/**
 * Shown when a query returns nothing. Says what is missing and, where there is
 * one, offers the action that would fill it.
 */
export function EmptyState({
  action,
  children,
  title,
}: {
  action?: ReactNode;
  children?: ReactNode;
  title?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface p-10 text-center">
      {title && <p className="font-display text-base font-semibold text-text">{title}</p>}
      {children && <div className={`text-sm text-text-2${title ? ' mt-2' : ''}`}>{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
