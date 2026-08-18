#!/usr/bin/env bun
/**
 * Regenerates the price tables for the **provider-agnostic** agents — Pi, omp
 * and opencode — from models.dev.
 *
 * Run it when the unpriced-models table on `/admin/price-tables` grows a row
 * someone cares about, or when a provider ships a model people are routing to:
 *
 *   bun run gen:price-tables
 *
 * ## Why models.dev and not each vendor's pricing page
 *
 * These three agents drive whatever provider the user holds credentials for, so
 * their tables are a *union*, and a union hand-maintained from twenty vendor
 * pages goes stale the week it lands — which is exactly how `codex` ended up
 * stuck in the GPT-4o era (P12-010). models.dev is the catalog opencode itself
 * builds its model list from, so the IDs here are by construction the IDs the
 * adapter will report. That alignment is the whole point: a rate that is right
 * but filed under a name the agent never emits prices nothing.
 *
 * The three **first-party** tables (`claude_code`, `codex`, `gemini_cli`) stay
 * hand-maintained from their vendor's own pricing page and are NOT touched here.
 * One vendor, one page, and the page carries things this catalog flattens away —
 * promotional windows with expiry dates, per-tier rates, cache-write multipliers.
 * models.dev had `gemini-3.6-flash` at its post-promotional rate while Google's
 * page still quotes the promotional one; the vendor page won, and should.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CATALOG_URL = 'https://models.dev/api.json';
const OUT_DIR = join(import.meta.dir, '..', 'apps', 'ingest', 'src', 'data');

/**
 * First-party model vendors only. Aggregators (OpenRouter, Together, Fireworks,
 * Bedrock, Azure, …) are deliberately excluded: they mostly re-serve these same
 * models under `<vendor>/<model>` names, which `resolveModelPrice` already
 * strips down to the bare key, and including them would add hundreds of rows
 * that differ from the first-party rate only by the aggregator's margin.
 *
 * Order is precedence: when two of them serve the same model id, the earlier
 * entry wins, so a model is priced by its own vendor rather than by whoever
 * resells it. Every such collision is printed — the generated diff is the review
 * gate, so they need to be visible, not silent.
 */
const PROVIDERS = [
  'anthropic',
  'openai',
  'google',
  'groq',
  'deepseek',
  'xai',
  'mistral',
  'moonshotai',
  'zai',
  'cohere',
  'alibaba',
  'minimax',
  'perplexity',
  'cerebras',
  'meta',
  'inception',
  'stepfun',
  'upstage',
  'longcat',
  'llama',
] as const;

const TARGETS = [
  { agent: 'pi', label: 'Pi' },
  { agent: 'omp', label: 'omp (oh-my-pi)' },
  { agent: 'opencode', label: 'opencode' },
] as const;

/**
 * Rows kept from the previous hand-written tables. opencode's dated Anthropic
 * snapshots predate this generator and are not in the catalog under those exact
 * names; dropping them would un-price events that already resolved.
 */
const PINNED: Record<string, Record<string, ModelPrice>> = {
  opencode: {
    'claude-haiku-4-5-20251001': {
      cache_read_per_mtok: 0.1,
      cache_write_per_mtok: 1.25,
      input_per_mtok: 1,
      output_per_mtok: 5,
    },
    'claude-opus-4-1-20250805': {
      cache_read_per_mtok: 1.5,
      cache_write_per_mtok: 18.75,
      input_per_mtok: 15,
      output_per_mtok: 75,
    },
    'claude-sonnet-4-5-20250929': {
      cache_read_per_mtok: 0.3,
      cache_write_per_mtok: 3.75,
      input_per_mtok: 3,
      output_per_mtok: 15,
    },
  },
};

/**
 * Rows where the vendor's own pricing page and the catalog disagree, and the
 * page wins. Kept tiny and each entry justified — this is not a place to hand-fix
 * rates, it is for the one thing a catalog structurally cannot carry: a
 * promotional rate with an expiry date.
 *
 * `apps/ingest/test/price-tables.test.ts` asserts the generated tables agree with
 * the hand-maintained ones on every shared model, so a disagreement that is not
 * listed here fails the suite rather than shipping two different prices for the
 * same model depending on which agent ran it.
 */
const VENDOR_OVERRIDES: Record<string, ModelPrice> = {
  // Google quotes $0.75/$3.75/$0.075 "through December 31, 2026", then double.
  // models.dev carries the post-promotional rate.
  // https://ai.google.dev/gemini-api/docs/pricing (retrieved 2026-08-18)
  'gemini-3.6-flash': {
    cache_read_per_mtok: 0.075,
    cache_write_per_mtok: 0.75,
    input_per_mtok: 0.75,
    output_per_mtok: 3.75,
  },
};

type ModelPrice = {
  cache_read_per_mtok: number;
  cache_write_per_mtok: number;
  input_per_mtok: number;
  output_per_mtok: number;
};

type CatalogCost = {
  cache_read?: number;
  cache_write?: number;
  input?: number;
  output?: number;
};

type Catalog = Record<string, { models?: Record<string, { cost?: CatalogCost }> }>;

function priceOf(cost: CatalogCost): ModelPrice | null {
  const input = cost.input ?? 0;
  const output = cost.output ?? 0;
  // Needs both halves. Zero on both is a catalog row with no real rate (free
  // tiers, placeholders for unreleased models); zero on one is an embedding or
  // rerank model, which is priced per input token only and is never what an
  // agent turn reports. Either way a zero would be indistinguishable from an
  // unpriced model on /admin/price-tables, so leave it out and let it bill $0
  // through the unknown-model path, which at least reports itself.
  if (input === 0 || output === 0) {
    return null;
  }
  return {
    // Absent means the provider documents no cache discount, not that cached
    // tokens are free — charge them as ordinary input rather than inventing a
    // discount. (Where a provider has no caching at all these counts are 0
    // anyway, so the rate never applies.)
    cache_read_per_mtok: cost.cache_read ?? input,
    // Same reasoning inverted: absent means no documented write premium, and the
    // tokens still cost their ordinary input rate.
    cache_write_per_mtok: cost.cache_write ?? input,
    input_per_mtok: input,
    output_per_mtok: output,
  };
}

function collect(catalog: Catalog): {
  conflicts: number;
  prices: Record<string, ModelPrice>;
  skipped: number;
} {
  const prices: Record<string, ModelPrice> = {};
  const origin: Record<string, string> = {};
  const conflicts: string[] = [];
  let skipped = 0;

  for (const provider of PROVIDERS) {
    const models = catalog[provider]?.models;
    if (!models) {
      throw new Error(`models.dev has no provider "${provider}" — update PROVIDERS`);
    }
    for (const [id, model] of Object.entries(models)) {
      if (!model.cost) {
        continue;
      }
      const price = priceOf(model.cost);
      if (!price) {
        skipped += 1;
        continue;
      }
      const existing = prices[id];
      if (existing) {
        // Bare-id keys mean a model served by two vendors has one row. PROVIDERS
        // order decides which, and a disagreement is worth seeing rather than
        // resolving quietly — it is usually a reseller's margin, but it could be
        // a genuine repricing the vendor page has and the catalog does not.
        if (JSON.stringify(existing) !== JSON.stringify(price)) {
          conflicts.push(
            `${id}: kept ${origin[id]} ${JSON.stringify(existing)}, ignored ${provider} ${JSON.stringify(price)}`,
          );
        }
        continue;
      }
      const override = VENDOR_OVERRIDES[id];
      if (override) {
        console.warn(
          `  override ${id}: vendor page ${JSON.stringify(override)} over catalog ${JSON.stringify(price)}`,
        );
      }
      prices[id] = override ?? price;
      origin[id] = provider;
    }
  }

  for (const conflict of conflicts) {
    console.warn(`  conflict ${conflict}`);
  }
  return { conflicts: conflicts.length, prices, skipped };
}

function comment(agent: string, label: string, retrieved: string, count: number): string {
  return [
    `${label} model rates, USD per million tokens. GENERATED — do not hand-edit;`,
    'refresh with `bun run gen:price-tables`.',
    `${label} drives whatever provider the user holds credentials for, so this table is a union of`,
    `${count} models from the ${PROVIDERS.length} first-party vendors in the models.dev catalog`,
    `(${CATALOG_URL}, retrieved ${retrieved}): ${PROVIDERS.join(', ')}.`,
    'models.dev is the catalog opencode builds its own model list from, so these keys are the',
    'names the adapter actually reports — a correct rate filed under a name the agent never emits',
    'prices nothing. Aggregators (OpenRouter, Bedrock, Azure, Together, …) are deliberately not',
    'sourced: they re-serve these same models under `<vendor>/<model>`, which the prefix fallback',
    "in cost.ts resolves to the row here, at the first-party rate rather than the aggregator's",
    'margin. Where a vendor documents no cache rate, cached tokens are charged as ordinary input',
    'rather than discounted; prompt-size tiers are flattened to the base tier, as elsewhere;',
    'embedding and rerank models are excluded (priced per input token only, and never what an',
    'agent turn reports).',
    agent === 'opencode'
      ? 'The dated claude-*-2025* keys are pinned by hand so events priced before this table was'
      : '',
    agent === 'opencode' ? 'generated still resolve.' : '',
    'Locally served models (Ollama, LM Studio, llama.cpp) are absent and bill $0 — which is their',
    'real per-token cost, though it makes them indistinguishable from an unpriced model on',
    '/admin/price-tables. A model from a vendor not listed above also bills $0 and is counted in',
    'unknown_model_events_total (P8-002).',
  ]
    .filter((part) => part.length > 0)
    .join(' ');
}

/**
 * `--from <path>` regenerates from a saved `api.json` instead of fetching. Two
 * uses: pinning an exact catalog so a regeneration is reproducible, and getting
 * the job done from a network Bun's fetch cannot reach models.dev through (a
 * TLS-terminating corporate proxy will do it) — `curl -o api.json
 * https://models.dev/api.json`, then pass the file.
 */
const fromFlag = Bun.argv.indexOf('--from');
const fromPath = fromFlag === -1 ? undefined : Bun.argv[fromFlag + 1];

async function loadCatalog(): Promise<Catalog> {
  if (fromPath) {
    console.log(`reading catalog from ${fromPath}`);
    return (await Bun.file(fromPath).json()) as Catalog;
  }
  const res = await fetch(CATALOG_URL);
  if (!res.ok) {
    throw new Error(`GET ${CATALOG_URL} → ${res.status}`);
  }
  return (await res.json()) as Catalog;
}

const catalog = await loadCatalog();
const { conflicts, prices, skipped } = collect(catalog);
const retrieved = new Date().toISOString().slice(0, 10);
const written: string[] = [];

for (const { agent, label } of TARGETS) {
  const merged = { ...prices, ...(PINNED[agent] ?? {}) };
  const sorted = Object.fromEntries(
    Object.keys(merged)
      .sort()
      .map((id) => {
        const p = merged[id] as ModelPrice;
        return [
          id,
          {
            cache_read_per_mtok: p.cache_read_per_mtok,
            cache_write_per_mtok: p.cache_write_per_mtok,
            input_per_mtok: p.input_per_mtok,
            output_per_mtok: p.output_per_mtok,
          },
        ];
      }),
  );
  const doc = {
    _comment: comment(agent, label, retrieved, Object.keys(sorted).length),
    generated_at: `${retrieved}T00:00:00Z`,
    prices: sorted,
    version: agent === 'opencode' ? 'opencode.v1' : `${agent}.v1`,
  };
  const path = join(OUT_DIR, `price-table.${agent}.v1.json`);
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
  written.push(path);
  console.log(`${agent}: ${Object.keys(sorted).length} models → ${path}`);
}

// Let biome decide key order rather than trying to reimplement its collation —
// it is case-insensitive natural sort with tie-breaks that are not worth
// reproducing, and getting it wrong means every regeneration fails `bun run
// check` on a diff that is pure whitespace.
const formatted = Bun.spawnSync(['bunx', 'biome', 'check', '--write', ...written], {
  stderr: 'pipe',
  stdout: 'pipe',
});
if (formatted.exitCode !== 0) {
  throw new Error(`biome could not format the generated tables:\n${formatted.stderr.toString()}`);
}

console.log(
  `skipped ${skipped} catalog entries priced on one side only or not at all; ` +
    `${conflicts} id(s) served by more than one vendor`,
);
// Keep the raw response around for diffing when a regeneration moves a number.
const snapshot = join(mkdtempSync(join(tmpdir(), 'models-dev-')), 'api.json');
writeFileSync(snapshot, JSON.stringify(catalog));
console.log(`catalog snapshot: ${snapshot}`);
