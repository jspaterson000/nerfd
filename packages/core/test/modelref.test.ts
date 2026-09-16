import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregate, costUsd, emptyMetrics, emptyModelRef, hostedEquivalentUsd, parseQuant, parseSize,
  priceFor, priceSnapshotDate, registerModelDeclarations, resolveModelRef, toReport, validateReport,
  type Row, type Session,
} from '../src/index.ts';

// The family field is the one thing packages/core/data/model-families.json
// can legitimately refine, so it is asserted by shape rather than by value.
// Everything else here is decided by this module and is asserted exactly.

test('resolveModelRef maps real ids from every serving mode', () => {
  const c = resolveModelRef('claude-opus-5', 'anthropic');
  assert.match(c.family ?? '', /^claude/);
  assert.equal(c.version, '5');
  assert.equal(c.provider, 'anthropic');
  assert.equal(c.serving_mode, 'hosted');
  assert.equal(c.quant, 'unknown');
  assert.equal(c.modified, false);

  const gpt = resolveModelRef('gpt-6-astra', 'openai', { toolProviderType: 'openai' });
  assert.equal(gpt.provider, 'openai');
  assert.equal(gpt.serving_mode, 'hosted');
  assert.match(gpt.family ?? '', /gpt/);

  const or = resolveModelRef('openrouter/qwen/qwen3-coder', null);
  assert.equal(or.provider, 'openrouter');
  assert.equal(or.serving_mode, 'hosted');
  assert.match(or.family ?? '', /qwen/);

  // Ollama tags carry size and quantisation; they are not routing variants.
  const ol = resolveModelRef('qwen3-coder:30b-a3b-q4_K_M', 'ollama');
  assert.equal(ol.provider, 'ollama');
  assert.equal(ol.serving_mode, 'local');
  assert.equal(ol.size, '30B-A3B');
  assert.equal(ol.quant, 'q4_K_M');
  assert.equal(ol.variant, null);

  // Only OpenRouter sells routing variants, so a variant names the router.
  const nitro = resolveModelRef('moonshotai/kimi-k2.7-code:nitro', null);
  assert.equal(nitro.provider, 'openrouter');
  assert.equal(nitro.variant, 'nitro');
  assert.match(nitro.family ?? '', /kimi/);

  // A subscription provider bills nothing per token: that is plan mode.
  const kimi = resolveModelRef('kimi-code/k3', null);
  assert.equal(kimi.provider, 'kimi-for-coding');
  assert.equal(kimi.serving_mode, 'plan');
  const glm = resolveModelRef('glm-5.3', 'zai-coding-plan');
  assert.equal(glm.provider, 'zai-coding-plan');
  assert.equal(glm.serving_mode, 'plan');
  assert.match(glm.family ?? '', /glm/);

  const ds = resolveModelRef('deepseek/deepseek-v4-pro', null);
  assert.equal(ds.provider, 'deepseek');
  assert.equal(ds.serving_mode, 'hosted');

  // Nothing but the name and the endpoint to go on: parse both.
  const run = resolveModelRef('qwen38-27b-abliterated', 'qwen38-runpod', {
    baseUrl: 'https://xyz-8000.proxy.runpod.net/v1',
    declaredName: 'Qwen 3.8 27B Abliterated AWQ INT4',
  });
  assert.equal(run.serving_mode, 'local');
  assert.equal(run.provider, 'self-hosted');
  assert.equal(run.size, '27B');
  assert.equal(run.quant, 'awq-int4');
  assert.equal(run.modified, true);
  assert.match(run.family ?? '', /qwen/);

  const gem = resolveModelRef('gemini-3.1-pro-preview', 'google');
  assert.equal(gem.provider, 'google');
  assert.match(gem.family ?? '', /gemini/);

  // An org prefix is part of the id, not the provider, when the tool said who.
  const oss = resolveModelRef('openai/gpt-oss-120b', 'groq');
  assert.equal(oss.provider, 'groq');
  assert.equal(oss.serving_mode, 'hosted');
  assert.match(oss.size ?? '', /^120B/);  // the family table knows it is MoE: 120B-A5.1B
  assert.match(oss.family ?? '', /oss/);

  const lm = resolveModelRef('lmstudio-community/Qwen3-Coder-30B-A3B-Instruct-GGUF', 'lmstudio', {
    declaredName: 'Qwen3 Coder 30B A3B Instruct GGUF Q8_0',
  });
  assert.equal(lm.provider, 'lmstudio');
  assert.equal(lm.serving_mode, 'local');
  assert.equal(lm.size, '30B-A3B');
  assert.equal(lm.quant, 'q8_0');
});

test('router ids, bracket suffixes and product tiers', () => {
  // A context-window suffix is part of what was bought, not of the model name.
  const fable = resolveModelRef('claude-fable-5-1[1m]', 'anthropic');
  assert.equal(fable.raw_id, 'claude-fable-5-1[1m]');
  assert.match(fable.family ?? '', /^claude/);
  assert.equal(fable.version, '5.1');
  assert.equal(fable.size, '1m-context');
  assert.equal(fable.serving_mode, 'hosted');

  // Auto-routers pick a different model per request: no identity at all.
  for (const id of ['openrouter/auto', 'openrouter/fusion', 'openrouter/pareto-code']) {
    const r = resolveModelRef(id, null);
    assert.equal(r.serving_mode, 'router', id);
    assert.equal(r.family, null, id);
    assert.equal(r.version, null, id);
  }
  assert.equal(resolveModelRef('model-router', 'azure').serving_mode, 'router');
  assert.equal(resolveModelRef('auto', 'gemini').serving_mode, 'router');

  // A plan speed tier is still the same weights underneath.
  const mm = resolveModelRef('MiniMax-M2.7-highspeed', null);
  assert.match(mm.family ?? '', /minimax/);
  assert.equal(mm.version, 'm2.7');
  assert.equal(mm.size, '229B-A10B');

  // Closed models carry a product tier in `size`, not a parameter count.
  assert.equal(resolveModelRef('gemini-3.1-pro-preview', 'google').size, 'pro');

  // Routers never land in a family or provider row.
  const base: Row = {
    tool: 'claude-code', model: 'openrouter/auto', effort: null, week: '2026-W38',
    ended_at: '2026-09-16T00:00:00Z', category: 'code', size: 'm',
    repo: { lang: 'ts', size: 'm', age: 'established' }, duration_s: 60,
    metrics: emptyMetrics(), rating: null, kept: 'unknown', survival_ratio: null,
    model_ref: resolveModelRef('openrouter/auto', null),
  };
  assert.equal(aggregate([base], ['family'])[0]!.key.family, '-');
  assert.equal(aggregate([base], ['provider'])[0]!.key.provider, '-');
});

test('local endpoints resolve by port, and anything unknown stays unknown', () => {
  assert.equal(resolveModelRef('x', null, { baseUrl: 'http://localhost:11434/v1' }).provider, 'ollama');
  assert.equal(resolveModelRef('x', null, { baseUrl: 'http://127.0.0.1:1234/v1' }).provider, 'lmstudio');
  assert.equal(resolveModelRef('x', null, { baseUrl: 'http://192.168.1.9:8080' }).provider, 'llama.cpp');
  assert.equal(resolveModelRef('x', null, { baseUrl: 'http://10.0.0.4:9999' }).provider, 'local-openai-compatible');
  assert.equal(resolveModelRef('x', null, { baseUrl: 'http://10.0.0.4:9999' }).serving_mode, 'local');

  const unknown = resolveModelRef('totally-made-up-thing', null);
  assert.equal(unknown.family, null);
  assert.equal(unknown.provider, null);
  assert.equal(unknown.quant, 'unknown');
  assert.equal(emptyModelRef().quant, 'unknown');
  assert.deepEqual(resolveModelRef(null, null).raw_id, null);
});

test('the name parser reads quantisation, size and modification markers', () => {
  assert.equal(parseQuant('Model-FP8'), 'fp8');
  assert.equal(parseQuant('model.mxfp4.gguf'), 'mxfp4');
  assert.equal(parseQuant('model-gptq-int4'), 'gptq-int4');
  assert.equal(parseQuant('Q4_K_M'), 'q4_K_M');
  assert.equal(parseQuant('model-bf16'), 'bf16');
  assert.equal(parseQuant('model-nf4'), 'nf4');
  assert.equal(parseQuant('qwen3-coder'), 'unknown');
  assert.equal(parseSize('llama-3.3-70b-versatile'), '70B');
  assert.equal(parseSize('qwen3-coder-480b-a35b'), '480B-A35B');
  assert.equal(parseSize('claude-opus-5'), null);
  assert.equal(resolveModelRef('some-model-heretic', null).modified, true);
  assert.equal(resolveModelRef('some-model-instruct', null).modified, false);
});

test('a user declaration beats everything else', () => {
  registerModelDeclarations({ 'mystery-box': { family: 'qwen3-coder', size: '27B', quant: 'awq-int4', modified: true } });
  const r = resolveModelRef('mystery-box', null);
  assert.equal(r.family, 'qwen3-coder');
  assert.equal(r.quant, 'awq-int4');
  assert.equal(r.modified, true);
  registerModelDeclarations({});
  assert.equal(resolveModelRef('mystery-box', null).family, null);
});

test('pricing comes from the dated snapshot, with the hand table as a backstop', () => {
  assert.match(priceSnapshotDate() ?? '', /^\d{4}-\d{2}-\d{2}$/);
  const m = { ...emptyMetrics(), tokens_in: 100_000, tokens_out: 10_000, tokens_cache_read: 1_000_000 };

  // string overload still works, and still agrees with the old hand table
  assert.ok(Math.abs(costUsd('claude-opus-5', m)! - 1.25) < 1e-9);
  assert.match(priceFor('claude-opus-5')!.source, /models\.dev/);
  assert.equal(costUsd('definitely-not-a-model', m), null);

  // a plan provider bills zero per token; the api-equivalent is the useful number
  const plan = resolveModelRef('glm-5.3', 'zai-coding-plan');
  const planCost = costUsd(plan, m);
  assert.ok(planCost != null && planCost > 0, 'plan sessions still get an api-equivalent price');

  // local weights have no per-token bill at all
  const local = resolveModelRef('qwen3-coder:30b-a3b-q4_K_M', 'ollama');
  assert.equal(costUsd(local, m), null);
});

test('hostedEquivalentUsd prices local tokens at the cheapest hosted twin', () => {
  const m = { ...emptyMetrics(), tokens_in: 1_000_000, tokens_out: 1_000_000, tokens_cache_read: 0 };
  const local = resolveModelRef('qwen3-coder:30b-a3b-q4_K_M', 'ollama');
  const equiv = hostedEquivalentUsd(local, m);
  assert.ok(equiv != null && equiv > 0);
  // It is a floor: no hosted endpoint of the same family is cheaper.
  const hostedSame = costUsd(resolveModelRef('qwen/qwen3-coder', 'openrouter'), m)!;
  assert.ok(equiv <= hostedSame + 1e-9);

  // Never for hosted or plan sessions: it would be double counting.
  assert.equal(hostedEquivalentUsd(resolveModelRef('claude-opus-5', 'anthropic'), m), null);
  assert.equal(hostedEquivalentUsd(null, m), null);
  // A local model whose family is unknown gets no invented number.
  assert.equal(hostedEquivalentUsd(resolveModelRef('homegrown-thing', null, { baseUrl: 'http://localhost:8000' }), m), null);
});

test('rows group by provider, quant, family and serving mode', () => {
  const base: Row = {
    reporter: 'r1', tool: 'claude-code', model: 'm', effort: null, week: '2026-W38',
    ended_at: '2026-09-16T00:00:00Z', category: 'code', size: 'm',
    repo: { lang: 'ts', size: 'm', age: 'established' }, duration_s: 600,
    metrics: { ...emptyMetrics(), tool_calls: 10, tool_call_errors: 1 },
    rating: 4, kept: 'kept', survival_ratio: 0.9,
  };
  const rows: Row[] = [
    { ...base, model_ref: resolveModelRef('qwen3-coder:30b-a3b-q4_K_M', 'ollama') },
    { ...base, model_ref: resolveModelRef('qwen3-coder:30b-a3b-q4_K_M', 'ollama') },
    { ...base, model_ref: resolveModelRef('qwen/qwen3-coder', 'openrouter'), metrics: { ...emptyMetrics(), tool_calls: 10, tool_call_errors: 5 } },
    { ...base },  // no model_ref at all: older records still aggregate
  ];
  const byProvider = aggregate(rows, ['provider']);
  assert.deepEqual(byProvider.map((g) => g.key.provider).sort(), ['-', 'ollama', 'openrouter']);
  assert.equal(aggregate(rows, ['quant']).find((g) => g.key.quant === 'q4_K_M')!.n, 2);
  assert.equal(aggregate(rows, ['serving_mode']).find((g) => g.key.serving_mode === 'local')!.n, 2);
  assert.equal(aggregate(rows, ['family']).find((g) => g.key.family === '-')!.n, 1);

  // tool-call error rate is over calls, not sessions
  const or = aggregate(rows, ['provider']).find((g) => g.key.provider === 'openrouter')!;
  assert.equal(or.tool_call_error_rate, 0.5);
  assert.equal(aggregate([{ ...base, metrics: emptyMetrics() }], ['model'])[0]!.tool_call_error_rate, null);
});

test('the public record keeps model_ref but never a user-chosen provider name', () => {
  const ref = resolveModelRef('my-secret-merge', 'daves-basement-box', { baseUrl: 'http://192.168.1.9:8080' });
  const s: Session = {
    id: 's1', tool: 'claude-code', tool_version: '2.1.0', model: 'my-secret-merge', model_ref: ref,
    effort: null, plan_id: 'custom-25', plan_usd_month: 25, plan_source: 'declared',
    started_at: '2026-09-16T10:00:00Z', ended_at: '2026-09-16T10:31:07.412Z', duration_s: 600,
    cwd: '/Users/someone/secret-project', repo: { lang: 'brandname', size: 'm', age: 'established' },
    category: 'code', category_source: 'inferred', size: 'm', first_prompt: null,
    metrics: emptyMetrics(), outcome: { rating: 4, kept: 'kept', note: 'private', rated_at: null },
    survival: { lines_added: 0, lines_surviving: null, ratio: null, checked_at: null },
    line_hashes: null, touched_files: [], transcript_path: null, shared_at: null,
    price_snapshot_date: '2026-09-16',
  };
  const r = toReport(s, 'install-id', '0.1.0')!;
  assert.equal(validateReport(r), null);
  assert.equal(r.model_ref.raw_provider, 'llama.cpp');       // not 'daves-basement-box'
  assert.equal(r.model_ref.serving_mode, 'local');
  assert.ok(!r.model.includes('secret'), 'an unresolvable id is replaced by its derived identity');
  assert.equal(r.repo.lang, 'other');                        // not a free-typed extension
  assert.equal(r.plan_id, 'custom');
  assert.equal(r.plan_usd_month, null);                      // a typed dollar amount is not sent
  assert.equal(r.ended_at, '2026-09-16T10:00:00.000Z');      // bucketed to the hour
  assert.notEqual(r.reporter_id, r.report_id);

  // The reporter id rotates weekly; the report id does not, so re-sends upsert.
  const later = toReport({ ...s, ended_at: '2026-09-23T10:00:00Z' }, 'install-id', '0.1.0')!;
  assert.notEqual(later.reporter_id, r.reporter_id);
  assert.equal(later.report_id, r.report_id);

  // A known hosted model keeps its real id.
  const hosted = toReport({ ...s, model: 'claude-opus-5', model_ref: resolveModelRef('claude-opus-5', 'anthropic') }, 'install-id', '0.1.0')!;
  assert.equal(hosted.model, 'claude-opus-5');
  assert.equal(hosted.model_ref.raw_provider, 'anthropic');
  assert.equal(validateReport({ ...hosted, model_ref: { ...hosted.model_ref, serving_mode: 'wishful' } }) != null, true);
});
