import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'danger';
export type ButtonSize = 'sm' | 'md';

const BASE =
  'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-opacity disabled:cursor-not-allowed disabled:opacity-50';

const VARIANT: Record<ButtonVariant, string> = {
  // The accent carries `text-bg`: near-black ink on lime in dark, near-white on
  // olive in light. Both directions are legible.
  danger: 'border border-crit-line bg-crit-soft text-crit hover:opacity-90',
  primary: 'bg-accent text-bg hover:opacity-90',
  secondary: 'border border-border text-text-2 hover:bg-surface-2 hover:text-text',
};

const SIZE: Record<ButtonSize, string> = {
  md: 'px-4 py-2 text-sm',
  sm: 'px-3 py-1.5 text-xs',
};

function classes(variant: ButtonVariant, size: ButtonSize, className?: string): string {
  return `${BASE} ${VARIANT[variant]} ${SIZE[size]}${className ? ` ${className}` : ''}`;
}

type Common = { size?: ButtonSize; variant?: ButtonVariant };

/**
 * The button primitive. Four variants, two sizes — the app had accumulated a
 * dozen slightly different spellings of the same accent fill.
 */
export function Button({
  children,
  className,
  size = 'md',
  variant = 'primary',
  ...rest
}: Common & { children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={classes(variant, size, className)} {...rest}>
      {children}
    </button>
  );
}

/** A link that reads as a button. Same surface, correct semantics for navigation. */
export function ButtonLink({
  children,
  className,
  size = 'md',
  variant = 'primary',
  ...rest
}: Common & { children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a className={classes(variant, size, className)} {...rest}>
      {children}
    </a>
  );
}
