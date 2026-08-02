import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';

/**
 * Form controls. The focus ring is the accent, which is the one place the
 * signature colour is load-bearing for accessibility rather than decoration.
 */
const CONTROL =
  'rounded-md border border-border bg-surface text-text placeholder:text-text-3 focus:border-accent focus:ring-1 focus:ring-accent focus:outline-none disabled:opacity-50';

/**
 * Scale only — width is a layout decision, not a size. `md` is the default
 * control and matches `Button` `md` height exactly (`py-2 text-sm`), so a
 * control and its submit button line up in a filter row without nudging. `sm`
 * pairs with `Button` `sm` the same way.
 *
 * `Field` makes its own control full-width; anywhere else, say so at the call
 * site (`className="w-full"`, `"flex-1"`).
 *
 * Measured: `sm` is 30px for every control and button. `md` is 38px for
 * everything except a `<select>`, which Chromium renders at 36 — its inner box
 * ignores the line-height, and forcing a height here would fight `Textarea`.
 * Don't "fix" that 2px inline; it is the browser, not the scale.
 */
const CONTROL_SIZE = {
  md: 'px-3 py-2 text-sm',
  sm: 'px-2 py-1.5 text-xs',
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

export function Textarea({
  className,
  size = 'md',
  ...rest
}: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'size'> & { size?: ControlSize }) {
  return <textarea className={controlClass(size, className)} {...rest} />;
}

/**
 * Label + control + optional hint, stacked.
 *
 * The association is explicit rather than by wrapping: `htmlFor` must match the
 * control's `id`. Wrapping is valid HTML but opaque to static analysis, and an
 * explicit pair survives the control being swapped for a custom component.
 *
 * This is the stacked-form layout, so it is also where full-width belongs — the
 * control fills the field, and the field is sized by the grid or column holding
 * it. Controls used inline (a filter row, a table cell) take their width from
 * the call site instead.
 */
export function Field({
  children,
  className,
  hint,
  htmlFor,
  label,
}: {
  children: ReactNode;
  /** The field's own width — `w-32` for a narrow numeric field in an inline row. */
  className?: string;
  hint?: ReactNode;
  htmlFor: string;
  label: string;
}) {
  return (
    <div
      className={`space-y-1.5 [&>input]:w-full [&>select]:w-full [&>textarea]:w-full${
        className ? ` ${className}` : ''
      }`}
    >
      <label htmlFor={htmlFor} className="block text-xs font-medium text-text-2">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-text-3">{hint}</p>}
    </div>
  );
}
