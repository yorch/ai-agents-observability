import { DateRangePicker, type Range } from './DateRangePicker';

export function ReportRangeControls({
  range,
  from,
  to,
  timezone = 'UTC',
  repo,
}: {
  range: Range;
  from?: string | undefined;
  to?: string | undefined;
  timezone?: string | undefined;
  repo?: string | undefined;
}) {
  return (
    <div className="flex flex-wrap items-end gap-3">
      <DateRangePicker range={range} />
      <form className="flex flex-wrap items-end gap-2" method="get">
        <label className="text-xs text-text-2">
          From
          <input
            className="mt-1 block rounded border border-border bg-surface px-2 py-1 text-sm"
            type="date"
            name="from"
            defaultValue={from}
          />
        </label>
        <label className="text-xs text-text-2">
          To
          <input
            className="mt-1 block rounded border border-border bg-surface px-2 py-1 text-sm"
            type="date"
            name="to"
            defaultValue={to}
          />
        </label>
        <label className="text-xs text-text-2">
          Timezone
          <select
            className="mt-1 block rounded border border-border bg-surface px-2 py-1 text-sm"
            name="tz"
            defaultValue={timezone}
          >
            <option value="UTC">UTC</option>
            <option value="America/New_York">New York</option>
            <option value="Europe/London">London</option>
            <option value="Asia/Tokyo">Tokyo</option>
          </select>
        </label>
        {repo && <input type="hidden" name="repo" value={repo} />}
        <button
          className="rounded border border-border px-3 py-1.5 text-sm text-text"
          type="submit"
        >
          Apply
        </button>
      </form>
    </div>
  );
}
