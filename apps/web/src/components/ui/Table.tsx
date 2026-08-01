import type { ReactNode } from 'react';

export type Column = {
  align?: 'left' | 'right';
  label: string;
  mono?: boolean;
};

/**
 * Table primitive. Wraps itself in an overflow container so a wide table
 * scrolls inside its own card rather than pushing the page sideways.
 */
export function Table({ children, columns }: { children: ReactNode; columns: Column[] }) {
  return (
    <div className="overflow-x-auto">
      {/* Column gutters are imposed by the table rather than by each cell, so
          rows built from bare `<td>`s stay aligned with the header. */}
      <table className="w-full text-sm [&_td]:pr-6 [&_td:last-child]:pr-0 [&_th]:pr-6 [&_th:last-child]:pr-0">
        <thead>
          <tr className="border-b border-border text-xs text-text-3">
            {columns.map((col) => (
              <th
                key={col.label}
                className={`whitespace-nowrap pb-2 ${
                  col.align === 'right' ? 'text-right' : 'text-left'
                }${col.mono ? ' font-mono' : ''}`}
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/** Body row with the shared hover treatment and hairline separator. */
export function Row({ children }: { children: ReactNode }) {
  return (
    <tr className="border-b border-border-subtle transition-colors last:border-0 hover:bg-surface-2">
      {children}
    </tr>
  );
}

/** Body cell. `num` right-aligns and sets the mono face for tabular figures. */
export function Cell({
  children,
  className,
  num,
}: {
  children: ReactNode;
  className?: string;
  num?: boolean;
}) {
  return (
    <td className={`py-2${num ? ' text-right font-mono' : ''}${className ? ` ${className}` : ''}`}>
      {children}
    </td>
  );
}
