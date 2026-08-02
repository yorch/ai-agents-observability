import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import { cx } from './cx';

/**
 * Form controls. The focus ring is the accent, which is the one place the
 * signature colour is load-bearing for accessibility rather than decoration.
 */
const CONTROL =
  'rounded-md border border-border bg-surface text-text placeholder:text-text-3 focus:border-accent focus:ring-1 focus:ring-accent focus:outline-none disabled:opacity-50';

/**
 * Scale only — width is a layout decision, not a size, so it lives on `Field`
 * or at the call site. Measured, each step matches the same `Button` size: `sm`
 * is 30px and `md` 38px for every control and button. The one exception is a
 * `<select>` at `md`, which Chromium renders at 36 because its inner box
 * ignores the line-height; forcing a height here would fight `Textarea`, so
 * don't "fix" that 2px — it is the browser, not the scale.
 */
const CONTROL_SIZE = {
  md: 'px-3 py-2 text-sm',
  sm: 'px-2 py-1.5 text-xs',
} as const;

export type ControlSize = keyof typeof CONTROL_SIZE;

/**
 * Fills the field with whatever the control is — matched by exclusion rather
 * than by tag, so a wrapped control or a future element still gets its width.
 */
const FILL_CONTROL = '[&>:not(label):not(p)]:w-full';

function controlClass(size: ControlSize, className?: string): string {
  return cx(CONTROL, CONTROL_SIZE[size], className);
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
 * This is the stacked-form layout, so it is also where full-width belongs: the
 * control fills the field, and the field is sized by whatever holds it.
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
    <div className={cx('space-y-1.5', FILL_CONTROL, className)}>
      <label htmlFor={htmlFor} className="block text-xs font-medium text-text-2">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-text-3">{hint}</p>}
    </div>
  );
}
