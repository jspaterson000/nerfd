import { allModels, catalog, lookupModels, priceSnapshotDate, type CatalogHit } from './catalog.ts';
import { familyTable, type ModelRef } from './modelref.ts';
import type { Metrics } from './types.ts';

// API-equivalent list prices in USD per million tokens. Most people on these
// tools are on a flat subscription, so this is "what the work would have cost
// at API rates", which is the only number comparable across vendors.
//
// Prices come from the dated models.dev snapshot in packages/core/data, not
// from a hand-maintained table, because the table was always stale and named
// versions that no longer exist. The hand table below survives only as a last
// resort for ids the snapshot has never heard of.

export interface Price {
  input: number;
  output: number;
  cache_read: number;
  cache_write?: number;
  source: string;
}

export const PRICES: Array<[RegExp, Price]> = [
  [/^claude-(fable|mythos)-5/,     { input: 10, output: 50, cache_read: 0.25, source: 'anthropic list, 2026-06' }],
  [/^claude-opus-5/,               { input: 5,  output: 25, cache_read: 0.50, source: 'anthropic list, 2026-06' }],
  [/^claude-opus-4-[678]/,         { input: 5,  output: 25, cache_read: 0.50, source: 'anthropic list, 2026-06' }],
  [/^claude-sonnet-5/,             { input: 2,  output: 10, cache_read: 0.20, source: 'anthropic list, 2026-06' }],
  [/^claude-sonnet-4-6/,           { input: 3,  output: 15, cache_read: 0.30, source: 'anthropic list, 2026-06' }],
  [/^claude-haiku-4-5/,            { input: 1,  output: 5,  cache_read: 0.10, source: 'anthropic list, 2026-06' }],
];

export { priceSnapshotDate };

/** True when this catalogue entry bills per token at all. */
function priced(hit: CatalogHit): boolean {
  const c = hit.model.cost;
  return !!c && typeof c.input === 'number' && (c.input > 0 || (c.output ?? 0) > 0);
}

function toPrice(hit: CatalogHit, note = ''): Price {
  const c = hit.model.cost ?? {};
  return {
    input: c.input ?? 0,
    output: c.output ?? 0,
    cache_read: c.cache_read ?? 0,
    cache_write: c.cache_write,
    source: `models.dev ${catalog().fetched_at.slice(0, 10)} ${hit.provider_id}/${hit.model_id}${note}`,
  };
}

// The family table is the normalised view ('qwen3-coder', not 'qwen'), so a
// local model and its hosted twin land on the same family. Cached: this runs
// over ~7,600 ids.
let familyCache: Map<string, string | null> | null = null;

export function normalisedFamily(modelId: string): string | null {
  familyCache ??= new Map();
  const key = modelId.toLowerCase();
  const hit = familyCache.get(key);
  if (hit !== undefined) return hit;
  const def = familyTable().find((f) => f.patterns.some((p) => { try { return new RegExp(p, 'i').test(key); } catch { return false; } }));
  const out = def?.family ?? null;
  familyCache.set(key, out);
  return out;
}

function sameFamily(hit: CatalogHit, family: string): boolean {
  return hit.model.family === family || normalisedFamily(hit.model_id) === family;
}

/**
 * Snapshot first: provider + model, then the model id across providers, then
 * the cheapest priced model in the same family. Plan and local providers
 * carry a zero price, which is true of the bill and useless as an
 * API-equivalent, so a zero-cost hit falls through to a real one.
 */
export function priceFor(model: string | ModelRef | null | undefined): Price | null {
  if (!model) return null;
  const ref = typeof model === 'string' ? null : model;
  const id = typeof model === 'string' ? model : (model.raw_id ?? null);

  // Locally served weights have no per-token bill. Pricing them at a hosted
  // rate would put invented dollars into spend, and a zero would make every
  // local row win the value tier outright. The notional figure has its own
  // function, hostedEquivalentUsd, and is never summed into spend.
  if (ref?.serving_mode === 'local') return null;

  if (id) {
    const direct = lookupModels(ref?.provider ?? ref?.raw_provider ?? null, id);
    const own = ref?.provider ? direct.find((h) => h.provider_id === ref.provider && priced(h)) : null;
    if (own) return toPrice(own);
    const any = direct.find(priced);
    if (any) return toPrice(any, ref && ref.serving_mode !== 'hosted' ? ' (api-equivalent)' : '');
  }

  const family = ref?.family ?? (id ? normalisedFamily(id) : null);
  if (family) {
    const cheapest = cheapestInFamily(family, ref?.size ?? null);
    if (cheapest) return toPrice(cheapest, ' (family)');
  }

  if (id) for (const [rx, p] of PRICES) if (rx.test(id)) return p;
  return null;
}

function cheapestInFamily(family: string, size: string | null): CatalogHit | null {
  const candidates = allModels().filter((h) => priced(h) && h.model.open_weights !== false && sameFamily(h, family));
  if (candidates.length === 0) return null;
  const sized = size ? candidates.filter((h) => h.model_id.toLowerCase().includes(size.toLowerCase())) : [];
  const pool = sized.length ? sized : candidates;
  // A blend, not the input price: a cheap-in, expensive-out host is not cheap.
  const blended = (h: CatalogHit) => (h.model.cost!.input ?? 0) + (h.model.cost!.output ?? 0) / 4;
  return pool.reduce((a, b) => (blended(b) < blended(a) ? b : a));
}

function apply(p: Price, m: Metrics): number {
  // tokens_in already includes cache-write tokens (billed at ~1.25x); the
  // small overstatement is accepted rather than tracked separately.
  return (m.tokens_in * p.input + m.tokens_out * p.output + m.tokens_cache_read * p.cache_read) / 1e6;
}

/** API-equivalent cost of a session in USD, or null when the model is unpriced. */
export function costUsd(model: string | ModelRef | null | undefined, m: Metrics): number | null {
  const p = priceFor(model);
  return p ? apply(p, m) : null;
}

/**
 * What the same tokens would have cost at the cheapest hosted endpoint of the
 * same family. Only for locally served models: it answers "what did running
 * this myself save me", and it is never summed into spend. Hardware
 * amortisation is not attempted: the collector cannot see the GPU, the duty
 * cycle or the power price, so any dollars-per-hour number would be invented.
 */
export function hostedEquivalentUsd(ref: ModelRef | null | undefined, m: Metrics): number | null {
  if (!ref || ref.serving_mode !== 'local') return null;
  const family = ref.family ?? (ref.raw_id ? normalisedFamily(ref.raw_id) : null);
  if (!family) return null;
  const hit = cheapestInFamily(family, ref.size);
  return hit ? apply(toPrice(hit), m) : null;
}
