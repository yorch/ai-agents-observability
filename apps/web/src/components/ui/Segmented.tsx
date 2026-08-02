import type { ReactNode } from 'react';

const WRAP = 'inline-flex gap-0.5 rounded-lg border border-border bg-surface-2 p-0.5';
const ITEM = 'rounded-md px-3 py-1 font-mono text-xs font-medium no-underline transition-colors';
const ON = 'bg-accent text-bg';
const OFF = 'text-text-3 hover:bg-surface hover:text-text';

/**
 * A small set of mutually exclusive choices — a date range, a view mode.
 *
 * Three near-identical range pickers existed before this (two `/me` day
 * selectors and the team-org range picker), each with its own geometry and its
 * own idea of what "selected" looks like.
 */
export function Segmented({ children, label }: { children: ReactNode; label: string }) {
  return (
    // `fieldset` rather than a div with role="group" — same semantics, native.
    <fieldset className={WRAP}>
      <legend className="sr-only">{label}</legend>
      {children}
    </fieldset>
  );
}

/** A link-shaped option, for selectors that navigate (server-rendered pages). */
export function SegmentedLink({
  children,
  href,
  selected,
}: {
  children: ReactNode;
  href: string;
  selected: boolean;
}) {
  return (
    <a
      href={href}
      aria-current={selected ? 'page' : undefined}
      className={`${ITEM} ${selected ? ON : OFF}`}
    >
      {children}
    </a>
  );
}

/** A button-shaped option, for selectors that act on the client. */
export function SegmentedButton({
  children,
  onClick,
  selected,
}: {
  children: ReactNode;
  onClick: () => void;
  selected: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`${ITEM} ${selected ? ON : OFF}`}
    >
      {children}
    </button>
  );
}
