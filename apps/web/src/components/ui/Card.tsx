import type { ReactNode } from 'react';

type CardProps = {
  /** Small secondary text under the title (e.g. "Trailing 30 days"). */
  caption?: ReactNode;
  children: ReactNode;
  /** Layout classes for the card itself — `md:col-span-2`, `h-full`. */
  className?: string;
  /**
   * Classes for the content block below the heading. Spacing between a card's
   * children belongs here, not on `className`: `space-y-*` acts on siblings,
   * and the card's own child is the single wrapper this renders.
   */
  contentClassName?: string;
  /** Right-aligned hint on the title row (e.g. "hover for detail"). */
  hint?: ReactNode;
  /**
   * Drop the inset for content that supplies its own — a `divide-y` list or a
   * table that should meet the card's border.
   */
  flush?: boolean;
  title?: ReactNode;
};

/**
 * The surface primitive. Depth comes from a hairline plus one surface step —
 * no shadows, no gradients. Every panel in the app is one of these.
 */
export function Card({
  caption,
  children,
  className,
  contentClassName,
  flush,
  hint,
  title,
}: CardProps) {
  const heading = title || hint || caption;
  const content = [heading ? 'mt-4' : '', contentClassName ?? ''].filter(Boolean).join(' ');

  return (
    <div
      className={`rounded-lg border border-border bg-surface${flush ? ' overflow-hidden' : ' p-4'}${
        className ? ` ${className}` : ''
      }`}
    >
      {(title || hint) && (
        <div className={`flex items-baseline justify-between gap-3${flush ? ' px-4 pt-4' : ''}`}>
          {title && <h2 className="font-display text-sm font-semibold text-text">{title}</h2>}
          {hint && <span className="text-xs text-text-3">{hint}</span>}
        </div>
      )}
      {caption && <p className={`mt-0.5 text-xs text-text-3${flush ? ' px-4' : ''}`}>{caption}</p>}
      {/* No wrapper when there is nothing to offset and nothing to style — an
          extra div would break a `space-y-*` passed on `className`. */}
      {content ? <div className={content}>{children}</div> : children}
    </div>
  );
}
