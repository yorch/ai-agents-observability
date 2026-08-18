import Link from 'next/link';
import { CloseIcon } from '@/components/icons';

export type FilterChip = {
  /** The current URL with this one filter removed. */
  href: string;
  label: string;
};

/**
 * Applied-filter chips above a result set: each chip removes its own filter,
 * "Clear all" removes every one. Without this row, the only signal that
 * filters are active is the values sitting inside the filter panel's controls.
 */
export function FilterChips({ chips, clearHref }: { chips: FilterChip[]; clearHref: string }) {
  if (chips.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-text-3">Filtered by</span>
      {chips.map((c) => (
        <Link
          key={c.label}
          href={c.href}
          aria-label={`Remove filter: ${c.label}`}
          className="inline-flex items-center gap-1.5 rounded-full border border-accent-line bg-accent-soft px-2.5 py-1 text-xs text-accent transition-opacity hover:opacity-80"
        >
          {c.label}
          <CloseIcon size={11} />
        </Link>
      ))}
      <Link href={clearHref} className="text-xs text-text-3 underline hover:text-text-2">
        Clear all
      </Link>
    </div>
  );
}
