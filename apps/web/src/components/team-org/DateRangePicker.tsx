'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { Segmented, SegmentedButton } from '@/components/ui/Segmented';

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
    <Segmented label="Date range">
      {ranges.map(({ label, value }) => (
        <SegmentedButton
          key={value}
          selected={range === value}
          onClick={() => handleRangeChange(value)}
        >
          {label}
        </SegmentedButton>
      ))}
    </Segmented>
  );
}
