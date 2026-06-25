import { DateRangePicker } from './DateRangePicker';

type PageHeaderProps = {
  breadcrumb?: string;
  description?: string;
  range?: 7 | 30 | 90;
  title: string;
};

export function PageHeader({ breadcrumb, description, range, title }: PageHeaderProps) {
  return (
    <div className={range !== undefined ? 'flex items-start justify-between' : undefined}>
      <div>
        {breadcrumb && (
          <p className="mb-1 text-xs uppercase tracking-wider text-white/40">{breadcrumb}</p>
        )}
        <h1 className="text-2xl font-semibold">{title}</h1>
        {description && <p className="mt-1 text-sm text-white/50">{description}</p>}
      </div>
      {range !== undefined && <DateRangePicker range={range} />}
    </div>
  );
}
