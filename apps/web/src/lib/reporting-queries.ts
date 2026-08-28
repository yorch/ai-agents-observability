import { getModelMix, getTopTools, getUsageSummary } from './me-queries';
import { getCostByModel, getOrgSummaryWithDelta, getOrgTopTools } from './org-queries';
import type { ReportDigest } from './reporting';
import { getTeamModelMix, getTeamSummaryWithDelta, getTeamTopTools } from './team-queries';
import { daysAgo } from './time';

const date = (value: Date) => value.toISOString().slice(0, 10);

function windowFor(days: number): { end: Date; priorStart: Date; start: Date } {
  const end = new Date();
  const start = daysAgo(days);
  return { end, priorStart: daysAgo(days * 2), start };
}

function base(
  scope: ReportDigest['scope'],
  days: number,
): Pick<ReportDigest, 'generatedAt' | 'notes' | 'period' | 'scope'> {
  const window = windowFor(days);
  return {
    generatedAt: new Date().toISOString(),
    notes: [
      'Only interactive runs are included.',
      'Costs are telemetry-derived and may differ from invoiced vendor spend.',
    ],
    period: { days, end: date(window.end), start: date(window.start) },
    scope,
  };
}

export async function getMyReport(userId: string, days: number): Promise<ReportDigest> {
  const { priorStart, start } = windowFor(days);
  const [current, prior, models, tools] = await Promise.all([
    getUsageSummary(userId, start),
    getUsageSummary(userId, priorStart, start),
    getModelMix(userId, start),
    getTopTools(userId, start, 5),
  ]);
  return {
    ...base({ label: 'My', type: 'me' }, days),
    metrics: [
      { current: current.totalCostUsd, label: 'Spend', prior: prior.totalCostUsd, unit: 'usd' },
      {
        current: current.sessionCount,
        label: 'Sessions',
        prior: prior.sessionCount,
        unit: 'count',
      },
      { current: current.totalHours, label: 'Active time', prior: prior.totalHours, unit: 'hours' },
      { current: current.repoCount, label: 'Repositories', prior: prior.repoCount, unit: 'count' },
    ],
    topModels: models.slice(0, 5).map((model) => ({
      costUsd: model.costUsd,
      model: model.model,
      sessions: model.sessionCount,
    })),
    topTools: tools.map((tool) => ({ calls: tool.callCount, name: tool.toolName })),
  };
}

export async function getTeamReport(input: {
  days: number;
  teamLabel: string;
  totalMemberCount: number;
  visibleIds: string[];
}): Promise<ReportDigest> {
  const { start } = windowFor(input.days);
  const [{ current, deltas }, models, tools] = await Promise.all([
    getTeamSummaryWithDelta(input.days, input.visibleIds, input.totalMemberCount),
    getTeamModelMix(start, input.visibleIds),
    getTeamTopTools(start, input.visibleIds, 5),
  ]);
  const prior = (value: number, relative: number | null) =>
    relative === null ? 0 : value / (1 + relative);
  return {
    ...base({ label: input.teamLabel, type: 'team' }, input.days),
    metrics: [
      {
        current: current.totalCostUsd,
        label: 'Spend',
        prior: prior(current.totalCostUsd, deltas.totalCostUsd),
        unit: 'usd',
      },
      {
        current: current.sessionCount,
        label: 'Sessions',
        prior: prior(current.sessionCount, deltas.sessionCount),
        unit: 'count',
      },
      {
        current: current.totalHours,
        label: 'Active time',
        prior: prior(current.totalHours, deltas.totalHours),
        unit: 'hours',
      },
      {
        current: current.activeMembers,
        label: 'Active members',
        prior: prior(current.activeMembers, deltas.activeMembers),
        unit: 'count',
      },
      {
        current: current.cacheHitRate,
        label: 'Cache hit rate',
        prior: prior(current.cacheHitRate, deltas.cacheHitRate),
        unit: 'percent',
      },
    ],
    notes: [
      ...base({ label: input.teamLabel, type: 'team' }, input.days).notes,
      'Aggregate only; members who opt out of team metadata sharing are excluded.',
    ],
    topModels: models.slice(0, 5).map((model) => ({
      costUsd: model.costUsd,
      model: model.model,
      sessions: model.sessionCount,
    })),
    topTools: tools.map((tool) => ({ calls: tool.callCount, name: tool.toolName })),
  };
}

export async function getOrgReport(days: number): Promise<ReportDigest> {
  const { start } = windowFor(days);
  const [{ current, deltas }, models, tools] = await Promise.all([
    getOrgSummaryWithDelta(days),
    getCostByModel(start),
    getOrgTopTools(start, 5),
  ]);
  const prior = (value: number, relative: number | null) =>
    relative === null ? 0 : value / (1 + relative);
  return {
    ...base({ label: 'Organization', type: 'org' }, days),
    metrics: [
      {
        current: current.totalCostUsd,
        label: 'Spend',
        prior: prior(current.totalCostUsd, deltas.totalCostUsd),
        unit: 'usd',
      },
      {
        current: current.sessionCount,
        label: 'Sessions',
        prior: prior(current.sessionCount, deltas.sessionCount),
        unit: 'count',
      },
      {
        current: current.totalHours,
        label: 'Active time',
        prior: prior(current.totalHours, deltas.totalHours),
        unit: 'hours',
      },
      {
        current: current.activeUsers,
        label: 'Active users',
        prior: prior(current.activeUsers, deltas.activeUsers),
        unit: 'count',
      },
      {
        current: current.cacheHitRate,
        label: 'Cache hit rate',
        prior: prior(current.cacheHitRate, deltas.cacheHitRate),
        unit: 'percent',
      },
    ],
    notes: [
      ...base({ label: 'Organization', type: 'org' }, days).notes,
      'Aggregate only; users who opt out of organization metadata sharing are excluded.',
    ],
    topModels: models.slice(0, 5).map((model) => ({
      costUsd: model.costUsd,
      model: model.model,
      sessions: model.sessionCount,
    })),
    topTools: tools.map((tool) => ({ calls: tool.callCount, name: tool.toolName })),
  };
}
