import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';

/**
 * Form controls. The focus ring is the accent, which is the one place the
 * signature colour is load-bearing for accessibility rather than decoration.
 */
const CONTROL =
  'rounded-md border border-border bg-surface text-text placeholder:text-text-3 focus:border-accent focus:ring-1 focus:ring-accent focus:outline-none disabled:opacity-50';

/** `md` fills its container; `sm` is the compact inline control used in filter rows. */
const CONTROL_SIZE = {
  md: 'w-full px-3 py-2 text-sm',
  sm: 'px-2 py-1 text-xs',
} as const;

export type ControlSize = keyof typeof CONTROL_SIZE;

function controlClass(size: ControlSize, className?: string): string {
  return `${CONTROL} ${CONTROL_SIZE[size]}${className ? ` ${className}` : ''}`;
}

export function Input({
  className,
  size = 'md',
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> & { size?: ControlSize }) {
  return <input className={controlClass(size, className)} {...rest} />;
}

export function Select({
  children,
  className,
  size = 'md',
  ...rest
}: Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> & {
  children: ReactNode;
  size?: ControlSize;
}) {
  return (
    <select className={controlClass(size, className)} {...rest}>
      {children}
    </select>
  );
}

/**
 * Label + control + optional hint, stacked.
 *
 * The association is explicit rather than by wrapping: `htmlFor` must match the
 * control's `id`. Wrapping is valid HTML but opaque to static analysis, and an
 * explicit pair survives the control being swapped for a custom component.
 */
export function Field({
  children,
  hint,
  htmlFor,
  label,
}: {
  children: ReactNode;
  hint?: ReactNode;
  htmlFor: string;
  label: string;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-xs font-medium text-text-2">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-text-3">{hint}</p>}
    </div>
  );
}
