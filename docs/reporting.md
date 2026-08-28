# Reporting and exports

`/me/report`, `/team/[slug]/report`, and `/org/report` render a completed-period
agent digest and expose the same payload as Markdown, CSV, and JSON.

Each report compares a trailing 7-, 30-, or 90-day period with the immediately
preceding period of equal length. A zero prior value is rendered as **new**, not as
an invented percentage. The report payload and renderers live in
`apps/web/src/lib/reporting.ts`, so every representation has identical metrics,
periods, and caveats.

## Scope and privacy

- **My report** contains only the authenticated developer's interactive sessions.
- **Team report** requires team-lead access and uses the same team metadata-sharing
  filter as the dashboard. It contains no member-level rows.
- **Organization report** requires aggregate org access and uses the organization
  metadata-sharing filter. It contains no member-level rows.

Reports never include transcript text. Their notes state that costs are derived from
captured telemetry rather than an invoice, and that only interactive runs appear.
CSV values are guarded against spreadsheet formula injection.
