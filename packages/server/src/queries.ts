import {
  aggregate, drift, familyTable, planSummaries, steeringRate, tierModels, weekly,
  type Group, type GroupKey, type Row,
} from '@nerfd/core';

const ALLOWED_BY = new Set<GroupKey>([
  'model', 'category', 'tool', 'week', 'lang', 'size', 'effort',
  // The provider board: the same weights, a different host, a different quant.
  'provider', 'quant', 'family', 'serving_mode',
]);
export const clamp = (n: number, lo: number, hi: number): number => Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo;
const result = (body: unknown): { body: unknown } => ({ body });

/** Shared public queries for Node and Cloudflare. Raw reports never leave this boundary. */
export function queryData(url: URL, source: (weeks: number) => Row[], readOnly: boolean, origin: string,
  counts?: { count(): number; reporters(): number }): { body: unknown } | undefined {
  const p = url.pathname;
      if (p === '/v1/stats') {
        const weeks = clamp(Number(url.searchParams.get('weeks') ?? 8), 1, 52);
        const by = (url.searchParams.get('by') ?? 'model').split(',').map((s) => s.trim()).filter((s): s is GroupKey => ALLOWED_BY.has(s as GroupKey));
        let rows = source(weeks);
        for (const f of ['category', 'tool', 'model', 'size'] as const) {
          const v = url.searchParams.get(f);
          if (v) rows = rows.filter((r) => r[f] === v);
        }
        const lang = url.searchParams.get('lang');
        if (lang) rows = rows.filter((r) => r.repo.lang === lang);
        return result({ weeks, by, n: rows.length, groups: aggregate(rows, by.length ? by : ['model']) });
      }

      if (p === '/v1/tiers') {
        const weeks = clamp(Number(url.searchParams.get('weeks') ?? 4), 1, 52);
        let rows = source(weeks);
        const cat = url.searchParams.get('category');
        if (cat) rows = rows.filter((r) => r.category === cat);
        const minN = readOnly ? 3 : clamp(Number(url.searchParams.get('min') ?? 10), 3, 500);
        return result({ weeks, n: rows.length, min_n: minN, tiers: tierModels(aggregate(rows, ['model']), minN) });
      }

      if (p === '/v1/plans') {
        const weeks = clamp(Number(url.searchParams.get('weeks') ?? 12), 1, 52);
        return result({ weeks, plans: planSummaries(source(weeks)) });
      }

      if (p === '/v1/drift') {
        const weeks = clamp(Number(url.searchParams.get('weeks') ?? 8), 2, 52);
        const rows = source(weeks);
        const models = [...new Set(rows.map((r) => r.model))];
        const out = models.map((m) => ({ model: m, drift: drift(rows, m), weekly: weekly(rows.filter((r) => r.model === m)) }));
        out.sort((a, b) => (b.drift?.current.n ?? 0) - (a.drift?.current.n ?? 0));
        return result({ weeks, n: rows.length, models: out });
      }

      if (p === '/v1/meta') {
        const rows = source(52);
        return result({
          mode: readOnly ? 'local' : 'public',
          reports: counts ? counts.count() : rows.length,
          reporters: counts ? counts.reporters() : 1,
          models: [...new Set(rows.map((r) => r.model))].sort(),
          categories: [...new Set(rows.map((r) => r.category))].sort(),
          langs: [...new Set(rows.map((r) => r.repo.lang))].sort(),
          origin,
        });
      }

      // The provider board: "same weights, different host". One section per
      // weights family, one row per provider x quant x serving mode, so a
      // fp8 endpoint and an int4 endpoint of the same model never average
      // together. Small cells are dropped rather than shown thin.
      if (p === '/v1/providers') {
        const weeks = clamp(Number(url.searchParams.get('weeks') ?? 8), 1, 52);
        let rows = source(weeks);
        const cat = url.searchParams.get('category');
        if (cat) rows = rows.filter((r) => r.category === cat);
        const minN = readOnly ? 3 : clamp(Number(url.searchParams.get('min') ?? 10), 3, 500);

        const groups = aggregate(rows, ['family', 'provider', 'quant', 'serving_mode'])
          // A router id was served by some host, picked per request, so it has
          // no attributable provider and no family. It is not a provider row.
          .filter((g) => g.key.family && g.key.family !== '-')
          .filter((g) => g.n >= minN);

        const meta = new Map(familyTable().map((f) => [f.family, f]));
        const byFamily = new Map<string, Group[]>();
        for (const g of groups) {
          const f = g.key.family!;
          if (!byFamily.has(f)) byFamily.set(f, []);
          byFamily.get(f)!.push(g);
        }
        const families = [...byFamily.entries()].map(([family, list]) => ({
          family,
          display: meta.get(family)?.display ?? family,
          open_weights: meta.get(family)?.open_weights ?? false,
          rows: list.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || b.n - a.n),
        }));
        families.sort((a, b) => total(b.rows) - total(a.rows) || a.family.localeCompare(b.family));
        return result({ weeks, min_n: minN, n: rows.length, families });
      }

      // The friction board: how much the human had to fight the model, per
      // model, from the behavioural signals. Lower steering is better, so the
      // best row is first and models with no signals sort to the bottom.
      if (p === '/v1/friction') {
        const weeks = clamp(Number(url.searchParams.get('weeks') ?? 8), 1, 52);
        let rows = source(weeks);
        const cat = url.searchParams.get('category');
        if (cat) rows = rows.filter((r) => r.category === cat);
        const models = aggregate(rows, ['model']).map((g) => ({
          model: g.key.model!,
          n: g.n,
          n_signals: g.n_signals,
          correction_rate: g.correction_rate,
          reprompt_rate: g.reprompt_rate,
          frustration_rate: g.frustration_rate,
          pushback_rate: g.pushback_rate,
          clarification_rate: g.clarification_rate,
          edit_without_read_rate: g.edit_without_read_rate,
          abandoned_rate: g.abandoned_rate,
          interrupt_rate: g.interrupt_rate,
          tool_call_error_rate: g.tool_call_error_rate,
          steering: steeringRate(g),
        }));
        models.sort((a, b) => (a.steering ?? Infinity) - (b.steering ?? Infinity) || b.n - a.n);
        return result({ weeks, n: rows.length, models });
      }

      if (p === '/export.json') {
        // Open data means aggregates, not raw rows. Raw reports carry a
        // reporter id and a timestamp; even bucketed they can be joined into
        // a fingerprint. The aggregate is the published dataset (CC BY 4.0).
        const rows = source(52);
        return result({
          licence: 'CC BY 4.0',
          generated_at: new Date().toISOString(),
          n: rows.length,
          by_model_week: aggregate(rows, ['model', 'week']),
          by_model_category_week: aggregate(rows, ['model', 'category', 'week']),
          by_model_tool_week: aggregate(rows, ['model', 'tool', 'week']),
          // The provider board's own cut, so "same weights, different host"
          // is in the open dataset and not only on the site.
          by_family_provider_quant_week: aggregate(rows, ['family', 'provider', 'quant', 'week']),
          plans: planSummaries(rows),
        });
      }

}

/** Sessions behind a family's rows, which is what orders the sections. */
function total(rows: Group[]): number {
  return rows.reduce((a, g) => a + g.n, 0);
}
