'use client';

import { agentDisplayName } from '@ai-agents-observability/schemas';
import { useCallback, useMemo, useState } from 'react';
import { Card, CardEmpty } from '@/components/ui';
import { fmtUsd } from '@/lib/fmt';

// C4: A "what if we routed X% of model A's retrieval spend to model B" simulator.
// The user picks a source model, a target model, and a traffic share. The
// simulation runs server-side (api/org/models/simulate) using the pure
// simulateRouting function from packages/schemas, which reads the per-agent
// price table and the observed retrieval spend.

type SimulatorProps = {
  /** Per agent: source models (with retrieval spend) and target models (all priced). */
  agents: { agentType: string; sourceModels: string[]; targetModels: string[] }[];
  /** The selected lookback range (days). */
  range: 7 | 30 | 90;
};

type SimResponse = {
  eligible: boolean;
  message?: string;
  rangeDays?: number;
  result?: {
    estimatedSavingUsd: number;
    estimatedMonthlySavingUsd: number;
    projectedTargetCostUsd: number;
    reroutedSourceCostUsd: number;
    savingRate: number;
    sourceInputRate: number;
    sourceTier: string | null;
    targetInputRate: number;
    targetTier: string | null;
    sourceCallCount: number;
    sourceSpendUsd: number;
    trafficShare: number;
  };
};

export function RoutingSimulator({ agents, range }: SimulatorProps) {
  const [agentType, setAgentType] = useState(agents[0]?.agentType ?? '');
  const [sourceModel, setSourceModel] = useState('');
  const [targetModel, setTargetModel] = useState('');
  const [trafficShare, setTrafficShare] = useState(0.5);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<SimResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sourceModelsForAgent = useMemo(
    () => agents.find((a) => a.agentType === agentType)?.sourceModels ?? [],
    [agents, agentType],
  );
  const targetModelsForAgent = useMemo(
    () =>
      (agents.find((a) => a.agentType === agentType)?.targetModels ?? []).filter(
        (m) => m !== sourceModel,
      ),
    [agents, agentType, sourceModel],
  );

  const runSimulation = useCallback(async () => {
    if (!agentType || !sourceModel || !targetModel) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        agent: agentType,
        from: sourceModel,
        range: String(range),
        share: String(trafficShare),
        to: targetModel,
      });
      const res = await fetch(`/api/org/models/simulate?${params}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setResult(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Simulation failed');
      setResult(null);
    } finally {
      setLoading(false);
    }
  }, [agentType, sourceModel, targetModel, trafficShare, range]);

  if (agents.length === 0) {
    return (
      <Card
        title="Routing simulator"
        caption="What if you routed a fraction of one model's retrieval spend to a cheaper model?"
      >
        <CardEmpty>No models with retrieval spend in this period.</CardEmpty>
      </Card>
    );
  }

  return (
    <Card
      title="Routing simulator"
      caption="What if you routed a fraction of one model's retrieval spend to a cheaper model? Uses the per-agent price table and observed retrieval-category spend."
    >
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <label className="space-y-1">
            <span className="text-xs font-mono uppercase tracking-widest text-text-3">Agent</span>
            <select
              className="w-full rounded border border-border bg-surface px-3 py-2 text-sm text-text"
              onChange={(e) => {
                setAgentType(e.target.value);
                setSourceModel('');
                setTargetModel('');
                setResult(null);
              }}
              value={agentType}
            >
              {agents.map((a) => (
                <option key={a.agentType} value={a.agentType}>
                  {agentDisplayName(a.agentType)}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-xs font-mono uppercase tracking-widest text-text-3">
              From model
            </span>
            <select
              className="w-full rounded border border-border bg-surface px-3 py-2 text-sm text-text"
              disabled={sourceModelsForAgent.length === 0}
              onChange={(e) => {
                setSourceModel(e.target.value);
                setResult(null);
              }}
              value={sourceModel}
            >
              <option value="">Select source model…</option>
              {sourceModelsForAgent.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-xs font-mono uppercase tracking-widest text-text-3">
              To model
            </span>
            <select
              className="w-full rounded border border-border bg-surface px-3 py-2 text-sm text-text"
              disabled={targetModelsForAgent.length === 0}
              onChange={(e) => {
                setTargetModel(e.target.value);
                setResult(null);
              }}
              value={targetModel}
            >
              <option value="">Select target model…</option>
              {targetModelsForAgent.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="block space-y-1">
          <span className="text-xs font-mono uppercase tracking-widest text-text-3">
            Traffic share: {(trafficShare * 100).toFixed(0)}%
          </span>
          <input
            className="w-full"
            max={1}
            min={0.05}
            onChange={(e) => {
              setTrafficShare(Number(e.target.value));
              setResult(null);
            }}
            step={0.05}
            type="range"
            value={trafficShare}
          />
        </label>

        <button
          className="rounded border border-border bg-surface px-4 py-2 text-sm font-medium text-text hover:bg-surface-2 disabled:opacity-50"
          disabled={!sourceModel || !targetModel || !agentType || loading}
          onClick={runSimulation}
          type="button"
        >
          {loading ? 'Simulating…' : 'Simulate'}
        </button>

        {error && <p className="text-sm text-crit">{error}</p>}

        {result && !result.eligible && (
          <p className="text-sm text-text-2">
            {result.message ?? 'No savings — the target model is not cheaper or is unpriced.'}
          </p>
        )}

        {result?.result && (
          <div className="space-y-3 rounded-lg border border-border bg-surface-2 p-4">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <SimStat
                label="Est. saving (window)"
                value={fmtUsd(result.result.estimatedSavingUsd)}
                accent="good"
              />
              <SimStat
                label="Est. monthly saving"
                value={fmtUsd(result.result.estimatedMonthlySavingUsd)}
                accent="good"
              />
              <SimStat label="Rerouted spend" value={fmtUsd(result.result.reroutedSourceCostUsd)} />
              <SimStat label="Target cost" value={fmtUsd(result.result.projectedTargetCostUsd)} />
            </div>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <SimStat
                label="Saving rate"
                value={`${(result.result.savingRate * 100).toFixed(0)}%`}
              />
              <SimStat
                label="Source rate"
                value={`$${result.result.sourceInputRate.toFixed(2)}/Mtok`}
              />
              <SimStat
                label="Target rate"
                value={`$${result.result.targetInputRate.toFixed(2)}/Mtok`}
              />
              <SimStat
                label="Source calls"
                value={result.result.sourceCallCount.toLocaleString()}
              />
            </div>
            <p className="text-xs text-text-3">
              Based on {result.rangeDays}-day retrieval-category spend. Savings are a rate-ratio
              estimate, not a guarantee — the target model may produce different output lengths or
              quality.
            </p>
          </div>
        )}
      </div>
    </Card>
  );
}

function SimStat({ label, value, accent }: { label: string; value: string; accent?: 'good' }) {
  const color = accent === 'good' ? 'text-good' : 'text-text';
  return (
    <div className="space-y-0.5">
      <p className="text-[10px] font-mono uppercase tracking-widest text-text-3">{label}</p>
      <p className={`text-sm font-mono font-medium ${color}`}>{value}</p>
    </div>
  );
}
