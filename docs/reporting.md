# Reporting and exports

`/me/report`, `/team/[slug]/report`, and `/org/report` render a trailing-period
agent digest with readout highlights, daily spend/session trends, and a 90-day
activity calendar. They also include a cost-versus-duration scatter, concurrency
signals, a UTC weekday/hour heatmap, and a complete-week digest table. They expose
the same aggregate payload as Markdown, CSV, JSON, or a portable report bundle.

The corresponding scoped trend pages are `/me/trends`, `/team/[slug]/trends`, and
`/org/trends`. They use the same visibility boundaries as their dashboards and are
intended for exploration; reports are the compact planning/readout surface.

Trend and report charts include exact-data tables. The scatter shows session cost
against duration (with aggregate scopes bucketed to preserve privacy), concurrency
reports peak overlap and the share of sessions that ran in parallel, and the
heatmap groups starts by UTC weekday and hour. Weekly digest rows use complete
Monday–Sunday UTC weeks, excluding the current partial week.

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

The bundle format is a JSON container with `report.json`, `report.md`, `report.csv`,
and an escaped standalone `report.html`, plus a manifest recording the period,
scope, schema version, and visibility policy. It deliberately contains no
member-level rows or transcripts.

Use `?range=7`, `?range=30`, or `?range=90` to select the window. Download links
preserve the selected range; an omitted or invalid range defaults to 30 days.

Individual session pages also include owner-scoped visual analysis for per-turn
cost, cumulative spend, cache efficiency, tool activity, model mix, and subagent
bursts. These visuals include exact data tables for accessible review and never
expose transcript content or owner-only evaluation data to aggregate views.
