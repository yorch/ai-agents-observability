// Shared SVG icon set. Replaces Unicode/emoji glyphs (← → ↑ ↓ ▲ ▼ ▶ ✓ ⚠ ↗ 👍 👎 🎉)
// that were previously used inline as UI icons. All icons draw on a 16×16 grid,
// inherit color via `currentColor`, and are stroke-based to match the hand-rolled
// icons already in UserMenu/ThemeToggle/etc. Pure presentational components with no
// client-only features, so they render in both Server and Client Components.

import type { SVGProps } from 'react';

type IconProps = {
  /** Pixel size for width & height. Defaults to 14 to sit comfortably beside text. */
  size?: number;
  className?: string;
  /** Stroke weight; filled icons ignore this. */
  strokeWidth?: number;
  /** When set, the icon is exposed to assistive tech with this label. Otherwise it's decorative. */
  title?: string;
} & Omit<SVGProps<SVGSVGElement>, 'width' | 'height' | 'strokeWidth'>;

function Icon({
  size = 14,
  strokeWidth = 1.5,
  title,
  children,
  ...rest
}: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

export function ArrowLeftIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M13 8H3M7 4L3 8l4 4" />
    </Icon>
  );
}

export function ArrowRightIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 8h10M9 4l4 4-4 4" />
    </Icon>
  );
}

export function ArrowUpIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 13V3M4 7l4-4 4 4" />
    </Icon>
  );
}

export function ArrowDownIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 3v10M4 9l4 4 4-4" />
    </Icon>
  );
}

/** Up-and-to-the-right arrow — external links. */
export function ExternalLinkIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 4h6v6M11.5 4.5L4 12" />
    </Icon>
  );
}

/** Solid triangle pointing up — "better than / above" indicators. */
export function TriangleUpIcon({ strokeWidth: _s, ...props }: IconProps) {
  return (
    <Icon strokeWidth={0} {...props}>
      <path d="M8 4l4.5 7.5h-9L8 4z" fill="currentColor" stroke="none" />
    </Icon>
  );
}

/** Solid triangle pointing down — "worse than / below" indicators. */
export function TriangleDownIcon({ strokeWidth: _s, ...props }: IconProps) {
  return (
    <Icon strokeWidth={0} {...props}>
      <path d="M8 12L3.5 4.5h9L8 12z" fill="currentColor" stroke="none" />
    </Icon>
  );
}

/** Solid caret pointing right — disclosure marker for <details>/<summary>. */
export function CaretRightIcon({ strokeWidth: _s, ...props }: IconProps) {
  return (
    <Icon strokeWidth={0} {...props}>
      <path d="M6 4l5 4-5 4V4z" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 8.5l3.5 3.5L13 4.5" />
    </Icon>
  );
}

/** Warning triangle with an exclamation mark. */
export function WarningIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 2.5l6 10.5H2L8 2.5z" />
      <path d="M8 6.5v3" />
      <path d="M8 11.5h.01" strokeWidth={Math.max((props.strokeWidth ?? 1.5) + 0.4, 1.9)} />
    </Icon>
  );
}

export function ThumbsUpIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5 7.5V13H3.2A1.2 1.2 0 0 1 2 11.8V8.7A1.2 1.2 0 0 1 3.2 7.5H5z" />
      <path d="M5 7.5l3-5.2c.9 0 1.6.7 1.6 1.6V6h3.1c.8 0 1.4.8 1.2 1.6l-1 4c-.1.6-.7 1.4-1.4 1.4H5" />
    </Icon>
  );
}

export function ThumbsDownIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5 8.5V3H3.2A1.2 1.2 0 0 0 2 4.2v3.1A1.2 1.2 0 0 0 3.2 8.5H5z" />
      <path d="M5 8.5l3 5.2c.9 0 1.6-.7 1.6-1.6V10h3.1c.8 0 1.4-.8 1.2-1.6l-1-4C11.8 3.8 11.2 3 10.5 3H5" />
    </Icon>
  );
}

/** Four-point sparkle — celebratory / clean-state accent. */
export function SparkleIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 2c.3 2.6 1.4 3.7 4 4-2.6.3-3.7 1.4-4 4-.3-2.6-1.4-3.7-4-4 2.6-.3 3.7-1.4 4-4z" />
      <path d="M12.5 9.5c.15 1.1.65 1.6 1.75 1.75-1.1.15-1.6.65-1.75 1.75-.15-1.1-.65-1.6-1.75-1.75 1.1-.15 1.6-.65 1.75-1.75z" />
    </Icon>
  );
}
