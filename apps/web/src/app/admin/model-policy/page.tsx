import {
  ADAPTER_AGENT_TYPES,
  agentDisplayName,
  DEFAULT_CHEAP_CATEGORIES,
  MODEL_TIERS,
  type ModelTier,
} from '@ai-agents-observability/schemas';
import {
  ActionForm,
  Badge,
  type BadgeTone,
  Button,
  Card,
  CardEmpty,
  Cell,
  Field,
  Input,
  Row,
  Select,
  Table,
} from '@/components/ui';
import { fmtUsd } from '@/lib/fmt';
import {
  buildModelPolicy,
  getModelPolicyOverrides,
  type StoredModelPolicy,
} from '@/lib/model-policy';
import { getModelPrices } from '@/lib/price-client';
import { requireOrgAdmin } from '@/lib/roles';
import { setAllowedModels, setCheapCategories, setModelTierOverride } from './actions';

export const dynamic = 'force-dynamic';

/**
 * `Badge`, not `SeriesBadge`, for the tier.
 *
 * `SeriesBadge` is the primitive for an *unordered* categorical set — its six
 * hues carry no rank, which is exactly right for "which agent" and exactly
 * wrong here. A tier is ordinal on cost (economy < standard < premium) and the
 * ordering is the only thing an admin is scanning this column for; rendering it
 * in two arbitrary series colours would throw that away. The status tones read
 * as the cost gradient — `good` for the cheap end, `warn` for the spend that
 * routing recommendations target — and the label carries the meaning anyway, so
 * nothing depends on colour alone.
 */
const TIER_TONE: Record<ModelTier, BadgeTone> = {
  economy: 'good',
  premium: 'warn',
  standard: 'neutral',
};

function TierBadge({ tier }: { tier: ModelTier | null }) {
  if (tier === null) {
    return <span className="text-text-3">—</span>;
  }
  return (
    <Badge dot={false} tone={TIER_TONE[tier]}>
      {tier}
    </Badge>
  );
}

/** A rate per Mtok, or an em dash when the price table doesn't carry the model. */
function rate(value: number | undefined): string {
  return value === undefined ? '—' : fmtUsd(value);
}

type AgentSection = {
  agentType: string;
  allowedModels: string[];
  cheapCategories: string[];
  /** The `?agent=` key ingest serves this agent's table under. */
  priceKey: string;
  /** null = table unreachable/unset; `{}` = table resolved but carries no models. */
  prices: Record<string, { input_per_mtok: number; output_per_mtok: number }> | null;
  rows: {
    derived: ModelTier | null;
    effective: ModelTier | null;
    inputRate: number | undefined;
    model: string;
    outputRate: number | undefined;
    override: ModelTier | null;
  }[];
};

async function loadSection(
  agentType: string,
  overrides: StoredModelPolicy | undefined,
): Promise<AgentSection> {
  const priceKey = agentType.toLowerCase();
  const prices = await getModelPrices(priceKey);

  // Two passes over the same prices: without overrides for the "derived" column,
  // with them for the effective policy. Derivation is pure and cheap.
  const derived = buildModelPolicy(agentType, prices).tiers;
  const effective = buildModelPolicy(agentType, prices, overrides).tiers;

  // A model may be overridden before it is priced, so the row set is the union
  // of the price table and the overrides — otherwise an override on a model the
  // table has dropped becomes invisible and unclearable.
  const models = [...new Set([...Object.keys(prices ?? {}), ...Object.keys(effective)])];

  const rows = models
    .map((model) => ({
      derived: derived[model] ?? null,
      effective: effective[model] ?? null,
      inputRate: prices?.[model]?.input_per_mtok,
      model,
      outputRate: prices?.[model]?.output_per_mtok,
      override: overrides?.tierOverrides[model] ?? null,
    }))
    // Dearest first — the models a routing recommendation would act on.
    .sort((a, b) => (b.inputRate ?? -1) - (a.inputRate ?? -1) || a.model.localeCompare(b.model));

  return {
    agentType,
    allowedModels: overrides?.allowedModels ?? [],
    cheapCategories: overrides?.cheapCategories ?? [],
    priceKey,
    prices,
    rows,
  };
}

export default async function ModelPolicyAdminPage() {
  await requireOrgAdmin();

  // One read of the stored overrides for the whole page; each section then only
  // pays for its own price-table fetch.
  const overrides = await getModelPolicyOverrides();
  const sections = await Promise.all(
    ADAPTER_AGENT_TYPES.map((agent) => loadSection(agent, overrides.get(agent))),
  );

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="font-display text-xl font-semibold tracking-tight text-text">
          Model policy
        </h1>
        <p className="text-sm text-text-2">
          Per-agent model tiers, allow-list and cheap-work categories. Tiers default to a ranking of
          each agent&apos;s own price table; an override replaces the derived tier for that model
          only. Routing recommendations and governance alerts both read this policy, so a change
          takes effect without a redeploy. Every change is audited.
        </p>
      </div>

      {sections.map((section) => (
        <Card
          key={section.agentType}
          title={agentDisplayName(section.agentType)}
          caption={
            <>
              <span className="font-mono">{section.priceKey}</span>
              {' · '}
              {section.prices === null
                ? 'price table unavailable'
                : `${Object.keys(section.prices).length} priced model(s)`}
            </>
          }
          contentClassName="space-y-6"
        >
          {section.rows.length === 0 ? (
            <CardEmpty>
              {section.prices === null
                ? 'Price table unavailable — tiers cannot be derived until ingest serves a table for this agent.'
                : 'No priced models in this table, so there is no tier to derive. An agent billed on a seat allowance ships an intentionally empty table; the allow-list and cheap categories below still apply.'}
            </CardEmpty>
          ) : (
            <Table
              columns={[
                { label: 'Model' },
                { label: 'Derived' },
                { label: 'Effective' },
                { align: 'right', label: 'Input /Mtok' },
                { align: 'right', label: 'Output /Mtok' },
                { label: 'Tier override' },
              ]}
            >
              {section.rows.map((row) => (
                <Row key={row.model}>
                  <Cell className="font-mono text-xs text-text">{row.model}</Cell>
                  <Cell>
                    <TierBadge tier={row.derived} />
                  </Cell>
                  <Cell>
                    <TierBadge tier={row.effective} />
                  </Cell>
                  <Cell num className="text-xs text-text-2">
                    {rate(row.inputRate)}
                  </Cell>
                  <Cell num className="text-xs text-text-2">
                    {rate(row.outputRate)}
                  </Cell>
                  <Cell>
                    <ActionForm
                      action={setModelTierOverride}
                      className="inline-flex flex-wrap items-center gap-2"
                    >
                      <input type="hidden" name="agentType" value={section.agentType} />
                      <input type="hidden" name="model" value={row.model} />
                      <Select
                        size="sm"
                        name="tier"
                        defaultValue={row.override ?? ''}
                        aria-label={`Tier override for ${row.model}`}
                      >
                        <option value="">(derived)</option>
                        {MODEL_TIERS.map((tier) => (
                          <option key={tier} value={tier}>
                            {tier}
                          </option>
                        ))}
                      </Select>
                      <Button size="sm" type="submit">
                        Save
                      </Button>
                    </ActionForm>
                  </Cell>
                </Row>
              ))}
            </Table>
          )}

          <div className="grid gap-6 border-t border-border-subtle pt-4 md:grid-cols-2">
            <ActionForm action={setAllowedModels} className="space-y-3">
              <input type="hidden" name="agentType" value={section.agentType} />
              <Field
                htmlFor={`allowed-${section.agentType}`}
                label="Allowed models"
                hint="Comma-separated model ids. Leave it empty for no allow-list at all — then every model is allowed. An empty list never means deny everything."
              >
                <Input
                  id={`allowed-${section.agentType}`}
                  name="models"
                  size="sm"
                  defaultValue={section.allowedModels.join(', ')}
                  placeholder="empty — every model allowed"
                />
              </Field>
              <Button size="sm" type="submit">
                Save allow-list
              </Button>
            </ActionForm>

            <ActionForm action={setCheapCategories} className="space-y-3">
              <input type="hidden" name="agentType" value={section.agentType} />
              <Field
                htmlFor={`cheap-${section.agentType}`}
                label="Cheap-work tool categories"
                hint={`Comma-separated tool categories whose work is cheap enough to route to a lower tier. Empty falls back to the defaults (${DEFAULT_CHEAP_CATEGORIES.join(', ')}).`}
              >
                <Input
                  id={`cheap-${section.agentType}`}
                  name="categories"
                  size="sm"
                  defaultValue={section.cheapCategories.join(', ')}
                  placeholder={DEFAULT_CHEAP_CATEGORIES.join(', ')}
                />
              </Field>
              <Button size="sm" type="submit">
                Save categories
              </Button>
            </ActionForm>
          </div>
        </Card>
      ))}
    </div>
  );
}
