import type { ReactNode } from 'react';

type Column = {
  align?: 'left' | 'right';
  label: string;
  mono?: boolean;
};

export function DataTable({ children, columns }: { children: ReactNode; columns: Column[] }) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-white/10 text-xs text-white/40">
          {columns.map((col) => (
            <th
              key={col.label}
              className={`pb-2 ${col.align === 'right' ? 'text-right' : 'text-left'}${col.mono ? ' font-mono' : ''}`}
            >
              {col.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}
