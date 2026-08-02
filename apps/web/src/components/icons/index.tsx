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

// ── Navigation ────────────────────────────────────────────────────────────
// Used by the rail. Same 16×16 stroke grid as everything above.

/** Line rising over a baseline — dashboards and overviews. */
export function ChartIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2 12.5 5.5 8l3 2L11 5.5 14 9" />
    </Icon>
  );
}

/** Ascending columns — adoption, distributions. */
export function BarsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.5 13V6.5M6.5 13V3M10.5 13V8.5M14 13v-3" />
    </Icon>
  );
}

/** Stacked rules — session and record lists. */
export function ListIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.5 4h11M2.5 8h11M2.5 12h7" />
    </Icon>
  );
}

/** Two figures — rosters, teams, members. */
export function PeopleIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="6" cy="5.5" r="2.3" />
      <path d="M2 13.2c0-2.2 1.8-3.5 4-3.5s4 1.3 4 3.5" />
      <path d="M10.8 3.6a2.3 2.3 0 0 1 0 4.4M11.5 9.9c1.6.3 2.7 1.5 2.7 3.3" />
    </Icon>
  );
}

/** Angle brackets over a slash — tools and MCP servers. */
export function CodeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.5 5 2 8l2.5 3M11.5 5 14 8l-2.5 3M9.5 3.5l-3 9" />
    </Icon>
  );
}

/** Cube — models. */
export function CubeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 2 13.5 5v6L8 14 2.5 11V5z" />
      <path d="M2.5 5 8 8l5.5-3M8 8v6" />
    </Icon>
  );
}

/** Shield — security and governance. */
export function ShieldIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 2 13 4v4c0 3.2-2.1 5.3-5 6.1C5.1 13.3 3 11.2 3 8V4z" />
    </Icon>
  );
}

/** Magnifier — search. */
export function SearchIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.4 10.4 3.1 3.1" />
    </Icon>
  );
}

/** Star — skills. */
export function StarIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m8 2.2 1.7 4 4.3.3-3.3 2.8 1 4.2L8 11.2l-3.7 2.3 1-4.2L2 6.5l4.3-.3z" />
    </Icon>
  );
}

/** Rounded chassis with two eyes — agents. */
export function AgentIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2.5" y="4.5" width="11" height="8" rx="2.2" />
      <path d="M8 4.5v-2M6 8.3h.01M10 8.3h.01" strokeWidth={1.8} />
    </Icon>
  );
}

/** Branch merging into a trunk — pull requests. */
export function PullRequestIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="4.5" cy="4" r="1.8" />
      <circle cx="4.5" cy="12" r="1.8" />
      <circle cx="11.5" cy="12" r="1.8" />
      <path d="M4.5 5.8v4.4M11.5 10.2V7.5a2 2 0 0 0-2-2H6.6" />
    </Icon>
  );
}

/** Dial with a needle — ROI, quality, benchmarks. */
export function GaugeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.5 12a5.5 5.5 0 1 1 11 0" />
      <path d="M8 12 10.8 7.8" />
    </Icon>
  );
}

/** Clock — delivery, jobs, retention. */
export function ClockIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="8" r="5.7" />
      <path d="M8 4.6V8l2.3 1.7" />
    </Icon>
  );
}

/** Toothed wheel — settings and admin. */
export function GearIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.8v1.6M8 12.6v1.6M14.2 8h-1.6M3.4 8H1.8M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1M12.4 12.4l-1.1-1.1M4.7 4.7 3.6 3.6" />
    </Icon>
  );
}

/** Key — access grants and roles. */
export function KeyIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="5.5" cy="10.5" r="2.8" />
      <path d="m7.6 8.6 5.2-5.2M10.6 5.6l1.6 1.6M12.2 4l1.5 1.5" />
    </Icon>
  );
}

/** Stacked discs — price tables, adapters, data stores. */
export function StackIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <ellipse cx="8" cy="4" rx="5.3" ry="2.1" />
      <path d="M2.7 4v4c0 1.2 2.4 2.1 5.3 2.1s5.3-.9 5.3-2.1V4" />
      <path d="M2.7 8v3.4c0 1.2 2.4 2.1 5.3 2.1s5.3-.9 5.3-2.1V8" />
    </Icon>
  );
}

/** Open book — knowledge. */
export function BookIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 4.3C6.9 3.3 5.4 2.8 3.6 2.8c-.6 0-1.1.5-1.1 1.1v7.3c0 .6.5 1.1 1.1 1.1 1.8 0 3.3.5 4.4 1.5 1.1-1 2.6-1.5 4.4-1.5.6 0 1.1-.5 1.1-1.1V3.9c0-.6-.5-1.1-1.1-1.1-1.8 0-3.3.5-4.4 1.5z" />
      <path d="M8 4.3v9.5" />
    </Icon>
  );
}

/** Bell — alerts. */
export function BellIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 7a4 4 0 0 1 8 0c0 2.6.7 3.7 1.3 4.3H2.7C3.3 10.7 4 9.6 4 7z" />
      <path d="M6.6 13.3a1.6 1.6 0 0 0 2.8 0" />
    </Icon>
  );
}

/** Concentric rings — benchmarks and targets. */
export function TargetIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="8" r="5.7" />
      <circle cx="8" cy="8" r="2.4" />
    </Icon>
  );
}

/** Page with a rule and a check — policy and governance. */
export function PolicyIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.2 2.5h6.3l3.3 3.3v7.7H3.2z" />
      <path d="M9.3 2.6v3.3h3.3M5.6 10.2l1.5 1.5 2.8-2.8" />
    </Icon>
  );
}

/** Arrow leaving a doorway — sign out. */
export function SignOutIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6.2 13.5H3.6a1.4 1.4 0 0 1-1.4-1.4V3.9a1.4 1.4 0 0 1 1.4-1.4h2.6M10.4 11.1 13.5 8l-3.1-3.1M13.5 8H6.2" />
    </Icon>
  );
}

/** Sun — the light theme. */
export function SunIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="8" r="2.7" />
      <path d="M8 1.1v1.1M8 13.8v1.1M1.1 8h1.1M13.8 8h1.1M3.25 3.25l.78.78M11.97 11.97l.78.78M11.97 4.03l.78-.78M4.03 11.97l-.78.78" />
    </Icon>
  );
}

/** Crescent — the dark theme. */
export function MoonIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 1.1a6.9 6.9 0 1 0 5.3 11.35A5.3 5.3 0 0 1 6.6 4.28 6.9 6.9 0 0 1 8 1.1Z" />
    </Icon>
  );
}

/** Head and shoulders — the account profile. */
export function UserIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="5.3" r="2.7" />
      <path d="M2.6 13.7c0-3 2.4-5 5.4-5s5.4 2 5.4 5" />
    </Icon>
  );
}

/** Padlock — privacy settings. */
export function LockIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3.2" y="6.8" width="9.6" height="7" rx="1.6" />
      <path d="M5.4 6.8V4.7a2.6 2.6 0 0 1 5.2 0v2.1" />
      <path d="M8 9.6v1.6" />
    </Icon>
  );
}

/** Ruled page — the audit log. */
export function LogIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2.4" y="2.4" width="11.2" height="11.2" rx="1.6" />
      <path d="M5.2 5.8h5.6M5.2 8h5.6M5.2 10.2h3.4" />
    </Icon>
  );
}
