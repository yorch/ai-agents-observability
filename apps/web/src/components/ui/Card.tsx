import type { ReactNode } from 'react';

type CardProps = {
  /** Small secondary text under the title (e.g. "Trailing 30 days"). */
  caption?: string;
  children: ReactNode;
  className?: string;
  /** Right-aligned hint on the title row (e.g. "hover for detail"). */
  hint?: ReactNode;
  title?: ReactNode;
};

/**
 * The surface primitive. Depth comes from a hairline plus one surface step —
 * no shadows, no gradients. Every panel in the app is one of these.
 */
export function Card({ caption, children, className, hint, title }: CardProps) {
  return (
    <div
      className={`rounded-lg border border-border bg-surface p-4${className ? ` ${className}` : ''}`}
    >
      {(title || hint) && (
        <div className="flex items-baseline justify-between gap-3">
          {title && <h2 className="font-display text-sm font-semibold text-text">{title}</h2>}
          {hint && <span className="text-xs text-text-3">{hint}</span>}
        </div>
      )}
      {caption && <p className="mt-0.5 text-xs text-text-3">{caption}</p>}
      <div className={title || caption ? 'mt-4' : undefined}>{children}</div>
    </div>
  );
}
