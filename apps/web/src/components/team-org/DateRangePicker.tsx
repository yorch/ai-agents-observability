'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';

export function DateRangePicker({ range }: { range: 7 | 30 | 90 }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const handleRangeChange = (days: 7 | 30 | 90) => {
    const params = new URLSearchParams(searchParams);
    params.set('range', String(days));
    router.replace(`${pathname}?${params.toString()}`);
  };

  const ranges = [
    { label: '7d', value: 7 as const },
    { label: '30d', value: 30 as const },
    { label: '90d', value: 90 as const },
  ];

  return (
    <div className="flex gap-2">
      {ranges.map(({ label, value }) => (
        <button
          key={value}
          type="button"
          onClick={() => handleRangeChange(value)}
          className={`rounded-full px-3 py-1 text-xs transition-colors ${
            range === value
              ? 'border border-white/20 bg-white/10 text-white'
              : 'text-white/50 hover:bg-white/5 hover:text-white'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
