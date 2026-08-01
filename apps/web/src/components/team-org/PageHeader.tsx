import { PageHeader as BasePageHeader } from '@/components/ui';
import { DateRangePicker } from './DateRangePicker';

type PageHeaderProps = {
  breadcrumb?: string;
  description?: string;
  range?: 7 | 30 | 90;
  title: string;
};

/**
 * Team/org page header — the `ui` primitive with this section's range picker
 * wired into its action slot, so the 18 dashboard routes don't each repeat the
 * composition. The primitive itself stays free of any particular control.
 */
export function PageHeader({ breadcrumb, description, range, title }: PageHeaderProps) {
  return (
    <BasePageHeader
      title={title}
      {...(breadcrumb ? { breadcrumb } : {})}
      {...(description ? { description } : {})}
      {...(range !== undefined ? { action: <DateRangePicker range={range} /> } : {})}
    />
  );
}
