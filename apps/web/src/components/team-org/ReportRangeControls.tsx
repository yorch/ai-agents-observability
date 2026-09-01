import { Field, Input, Select } from '@/components/ui';
import { DateRangePicker, type Range } from './DateRangePicker';

/**
 * The trends pages' window controls: the trailing presets, an explicit
 * from/to window, a timezone, and the repo filter.
 *
 * The repo filter was reachable only by hand-typing `?repo=owner/name` — it was
 * plumbed through every trend query and carried in a hidden input, but nothing
 * in the app ever linked to it and nothing showed it was on. It is a real
 * control now, and an active one renders as a removable chip below.
 */
export function ReportRangeControls({
  basePath,
  from,
  range,
  repo,
  repos = [],
  timezone = 'UTC',
  to,
}: {
  /** Where "clear" returns to — the page's own path, without a query. */
  basePath: string;
  from?: string | undefined;
  /** null while a custom from/to window is active, so no preset looks selected. */
  range: Range | null;
  repo?: string | undefined;
  repos?: string[];
  timezone?: string | undefined;
  to?: string | undefined;
}) {
  const custom = Boolean(from || to);

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap items-end gap-3">
        {/* A preset clears the custom window but keeps timezone and repo. */}
        <DateRangePicker range={range} preserve={{ repo, tz: timezone }} />
        <form className="flex flex-wrap items-end gap-2" method="get">
          <Field label="From" htmlFor="range-from" className="w-36">
            <Input id="range-from" type="date" name="from" defaultValue={from} className="w-full" />
          </Field>
          <Field label="To" htmlFor="range-to" className="w-36">
            <Input id="range-to" type="date" name="to" defaultValue={to} className="w-full" />
          </Field>
          <Field label="Timezone" htmlFor="range-tz" className="w-40">
            <Select id="range-tz" name="tz" defaultValue={timezone} className="w-full">
              <option value="UTC">UTC</option>
              <option value="America/New_York">New York</option>
              <option value="Europe/London">London</option>
              <option value="Asia/Tokyo">Tokyo</option>
            </Select>
          </Field>
          <Field label="Repo" htmlFor="range-repo" className="w-52">
            <Select id="range-repo" name="repo" defaultValue={repo ?? ''} className="w-full">
              <option value="">All repos</option>
              {repos.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </Select>
          </Field>
          <button
            className="h-[30px] rounded border border-border px-3 text-sm text-text"
            type="submit"
          >
            Apply
          </button>
        </form>
      </div>

      {(custom || repo) && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-text-3">Filtered to</span>
          {repo && (
            <span className="rounded-md border border-border bg-surface-2 px-2 py-0.5 font-mono text-text-2">
              {repo}
            </span>
          )}
          {custom && (
            <span className="rounded-md border border-border bg-surface-2 px-2 py-0.5 font-mono text-text-2">
              {from ?? '…'} → {to ?? '…'}
            </span>
          )}
          <a href={basePath} className="text-accent hover:underline">
            Clear
          </a>
        </div>
      )}
    </div>
  );
}
