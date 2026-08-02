/**
 * Loading placeholders. Blocks sit one surface step above whatever they are on
 * — `bg-surface` would be invisible in light mode, where the card surface is
 * white on a near-white canvas — and card-shaped ones carry the same hairline
 * as `Card` so the page keeps its shape while it loads.
 */
export function SkeletonCard({ className }: { className?: string }) {
  return (
    <div
      className={`rounded-lg border border-border bg-surface${className ? ` ${className}` : ''}`}
    />
  );
}

export function SkeletonBar({ className }: { className?: string }) {
  return <div className={`rounded bg-surface-2${className ? ` ${className}` : ''}`} />;
}
