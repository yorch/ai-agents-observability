import { seriesBg } from './scale';

/**
 * Legends are always present for two or more series, so identity never rests
 * on colour alone. A single-series chart needs none — its title names it.
 */
export function Legend({ items }: { items: { label: string; index: number }[] }) {
  if (items.length < 2) {
    return null;
  }
  return (
    <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-1.5 text-xs text-text-2">
          <span className={`h-2 w-2 shrink-0 rounded-sm ${seriesBg(item.index)}`} />
          {item.label}
        </li>
      ))}
    </ul>
  );
}
