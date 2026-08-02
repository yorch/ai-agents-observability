import type { ReactNode } from 'react';

/**
 * The page title block. One per route, directly inside the canvas — the rail
 * carries navigation, so this only has to identify the page and host its
 * primary control (a range picker, a filter).
 */
export function PageHeader({
  action,
  breadcrumb,
  description,
  title,
}: {
  /** Right-aligned control — a DateRangePicker, a filter, a primary button. */
  action?: ReactNode;
  /** Scope label above the title: "Organization", a team name. */
  breadcrumb?: string;
  description?: ReactNode;
  title: string;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        {breadcrumb && (
          <p className="mb-1 font-mono text-[10px] uppercase tracking-widest text-text-3">
            {breadcrumb}
          </p>
        )}
        <h1 className="font-display text-2xl font-semibold tracking-tight text-text">{title}</h1>
        {description && <p className="mt-1 text-sm text-text-2">{description}</p>}
      </div>
      {action}
    </div>
  );
}

/** Small uppercase label that groups a run of cards under one idea. */
export function SectionHeader({ children }: { children: ReactNode }) {
  return (
    <h2 className="mb-3 font-mono text-[10px] uppercase tracking-widest text-text-3">{children}</h2>
  );
}
