// Shared inline assets keep the public page and local dashboard in one visual family.
export const FAVICON = `<link rel="icon" href="/assets/logos/nerfd.svg">`;

export const IDENTITY_JS = `
function logoFor(id) {
  const key = String(id ?? '').toLowerCase().split('/').pop();
  const match = [
    [/^(claude|anthropic)/, 'anthropic'], [/^(gpt|o1|o3|o4|openai|codex|chatgpt)/, 'openai'],
    [/^(gemini|gemma|google)/, 'google'], [/^(kimi|moonshot)/, 'moonshotai'],
    [/^(glm|zai|zhipu)/, 'zai'], [/^deepseek/, 'deepseek'], [/^(qwen|alibaba)/, 'alibaba'],
    [/^minimax/, 'minimax'], [/^(llama|muse|meta)/, 'meta'], [/^(mistral|devstral|codestral)/, 'mistral'],
    [/^(grok|xai)/, 'xai'], [/^openrouter/, 'openrouter'], [/^groq/, 'groq'],
    [/^cerebras/, 'cerebras'], [/^together/, 'together'], [/^fireworks/, 'fireworks'], [/^deepinfra/, 'deepinfra'], [/^ollama/, 'ollama'], [/^lm[ -]?studio/, 'lmstudio'], [/^opencode/, 'opencode'], [/^(github|copilot)/, 'github']
  ].find(([pattern]) => pattern.test(key));
  return match ? match[1] : null;
}
function identity(label, provider) {
  const name = String(label ?? 'Unknown');
  const logo = logoFor(name) || logoFor(provider);
  const icon = logo ? '<img src="/assets/logos/' + logo + '.svg" width="18" height="18" alt="" onerror="this.hidden=true;this.nextElementSibling.hidden=false">' : '';
  const fallback = '<span class="logo-fallback"' + (logo ? ' hidden' : '') + '>' + esc(name.charAt(0).toUpperCase()) + '</span>';
  const host = provider && String(provider) !== name ? '<small class="provider">' + identity(provider) + '</small>' : '';
  return '<span class="identity"><span class="logo">' + icon + fallback + '</span><span>' + esc(name) + '</span>' + host + '</span>';
}
`;

export const SHARED_CSS = `
:root{color-scheme:light dark;--bg:#fbfbfc;--fg:#242528;--mut:#686a70;--line:#e2e3e6;--soft:#f0f1f3;--panel:#fff;--hover:#f6f7f9;--warn:#946000;--bad:#bb3945;--ok:#357452;--mono:"SF Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media(prefers-color-scheme:dark){:root{--bg:#202124;--fg:#ededf0;--mut:#a2a4ac;--line:#3b3c41;--soft:#292a2e;--panel:#27282c;--hover:#303136;--warn:#e2b46b;--bad:#f48b93;--ok:#8ac7a4}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",sans-serif;-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums}
a{color:inherit;text-decoration:none}a:hover{text-decoration:underline;text-underline-offset:4px}
button,select,input{font:inherit;color:var(--fg)}
button,select{background:var(--panel);border:1px solid var(--line);border-radius:7px;padding:6px 10px}
button{cursor:pointer}button:hover{background:var(--hover);border-color:var(--mut)}
:focus-visible{outline:2px solid #668cc5;outline-offset:4px}
.mono,code,.n,.tier,.stat b{font-family:var(--mono)}
.mut,.sub,.fine{color:var(--mut)}
.brand{display:inline-flex;align-items:center;gap:9px;font-size:21px;font-weight:650;letter-spacing:-.8px;white-space:nowrap}
.brand em{font-style:normal;color:var(--mut);font-weight:450}.app-icon{display:inline-grid;place-items:center;width:29px;height:29px;border-radius:8px;background:var(--fg);color:var(--bg);font-size:23px;line-height:1;letter-spacing:-1px;box-shadow:inset 0 0 0 1px #ffffff12}
.identity{display:inline-flex;align-items:center;gap:9px;font-family:inherit;font-weight:500;vertical-align:middle}
.logo{display:inline-grid;place-items:center;width:26px;height:26px;flex:none;border:1px solid var(--line);border-radius:7px;background:#fff;color:#494b51}
.logo img{display:block;object-fit:contain;width:18px;height:18px}.logo [hidden]{display:none}
.logo-fallback{font:600 12px var(--mono)}.provider{display:inline-flex;color:var(--mut);font-size:11px;font-weight:400;margin-left:4px}.provider .logo{width:22px;height:22px}.provider .logo img{width:16px;height:16px}
.tbl,.table-wrap{max-width:100%;overflow:auto;border:1px solid var(--line);border-radius:11px;background:var(--panel);-webkit-overflow-scrolling:touch}
table{border-collapse:collapse;width:100%;font-size:13px;font-variant-numeric:tabular-nums}
th,td{padding:12px 14px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap;vertical-align:middle}
th{font-size:10px;font-weight:600;letter-spacing:.055em;text-transform:uppercase;color:var(--mut);background:var(--soft)}
tbody tr:last-child td{border-bottom:0}tbody tr:hover{background:var(--hover)}
td.n,th.n{text-align:right}td:not(:first-child){font-variant-numeric:tabular-nums}
.tier{display:inline-block;min-width:24px;line-height:21px;text-align:center;border:1px solid var(--line);border-radius:6px;padding:0 5px;font-size:11px;font-weight:600;margin-right:6px;background:var(--soft);color:var(--mut)}
.tier.S{background:var(--fg);color:var(--bg);border-color:var(--fg)}.tier.A{border-color:var(--mut);background:var(--panel);color:var(--fg)}
.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border:1px solid var(--line);border-radius:12px;background:var(--panel);overflow:hidden}
.stat{padding:20px 24px;border-right:1px solid var(--line)}.stat:last-child{border-right:0}.stat b{display:block;font-size:27px;font-weight:500;line-height:1.3;letter-spacing:-1px}.stat span{display:block;font-size:12px;color:var(--mut);margin-top:5px}.stat svg{width:15px;height:15px;vertical-align:-3px;margin-right:6px;stroke:currentColor;fill:none;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
main,section{min-width:0;max-width:100%}
.section-head{display:flex;align-items:baseline;justify-content:space-between;gap:16px}.section-head a{font-size:12px;color:var(--mut)}
.family-card{margin:16px 0;border:1px solid var(--line);border-radius:12px;background:var(--panel);overflow:hidden}
.family-card h3{display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin:0;padding:16px;font-size:14px;font-weight:600}.family-display{font-size:12px;font-weight:400}
.family-card .table-wrap{border:0;border-top:1px solid var(--line);border-radius:0}
.chip{display:inline-block;padding:2px 6px;border:1px solid var(--line);border-radius:5px;font-size:10px;font-weight:500;white-space:nowrap;background:var(--soft)}
.mode{color:var(--mut);font-size:11px}.cost-note{display:block;color:var(--mut);font-size:10px}
.row-group th{padding:7px 14px;font-size:9px;letter-spacing:.06em;border-top:1px solid var(--line)}
.local-row td:first-child,.modified-row td:first-child{border-left:3px solid var(--mut)}
.tool-error{background:var(--soft);font-weight:600}
.rate{display:inline-block;min-width:58px;padding:2px 4px;border-radius:3px;background:linear-gradient(to right,var(--line) var(--rate),transparent var(--rate));font-family:var(--mono);font-size:11px}
.metric-note{font-size:12px;line-height:1.65;margin:12px 0 0;max-width:940px}.metric-note a,.sub a{text-decoration:underline;text-underline-offset:3px}
.empty{padding:20px;color:var(--mut);white-space:normal}
#friction>.eyebrow{margin:24px 0 6px}#friction h2{margin-top:0}.family-card h3 .identity{min-width:0;overflow-wrap:anywhere}.family-card h3 .identity>span:last-child{min-width:0}
.eyebrow{font-size:11px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--mut)}
@media(max-width:600px){.stats{grid-template-columns:repeat(2,minmax(0,1fr))}.stat{padding:16px 18px}.stat:nth-child(2){border-right:0}.stat:nth-child(-n+2){border-bottom:1px solid var(--line)}.stat b{font-size:24px}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
`;

export const STAT_STRIP = `<div class="stats" aria-label="At a glance">
<div class="stat"><b id="s-sessions">–</b><span><svg viewBox="0 0 18 18" aria-hidden="true"><rect x="2" y="3" width="14" height="12" rx="3"/><path d="m5 7 2 2-2 2m5 0h3"/></svg>Sessions</span></div>
<div class="stat"><b id="s-reporters">–</b><span><svg viewBox="0 0 18 18" aria-hidden="true"><circle cx="7" cy="6" r="2.5"/><path d="M2 15v-1a5 5 0 0 1 10 0v1m0-11a2.5 2.5 0 0 1 0 5m2 2a4 4 0 0 1 2 4"/></svg>Reporters</span></div>
<div class="stat"><b id="s-models">–</b><span><svg viewBox="0 0 18 18" aria-hidden="true"><rect x="4" y="4" width="10" height="10" rx="2"/><path d="M7 1v3m4-3v3M7 14v3m4-3v3M1 7h3m-3 4h3m10-4h3m-3 4h3"/></svg>Models</span></div>
<div class="stat"><b id="s-week">–</b><span><svg viewBox="0 0 18 18" aria-hidden="true"><rect x="2" y="4" width="14" height="12" rx="3"/><path d="M5 2v4m8-4v4M2 8h14m-11 3h2m3 0h2"/></svg>Sessions this week</span></div>
</div>`;

export const BASE_CSS = SHARED_CSS + `
body{padding:0 28px 48px;max-width:1440px;margin:auto;font-size:13px}
header{display:flex;flex-wrap:wrap;gap:12px 24px;align-items:center;min-height:72px;border-bottom:1px solid var(--line)}
header nav{display:flex;gap:20px;margin-left:auto;color:var(--mut);font-size:12px}
.board-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;margin:26px 0 18px}.board-heading h1{font-size:25px;letter-spacing:-.7px;line-height:1.2;margin:0 0 5px;font-weight:600}.board-heading p{margin:0}.status{font-size:11px;padding:4px 10px;border:1px solid var(--line);border-radius:20px;color:var(--mut);white-space:nowrap}.status::before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--ok);margin-right:6px}
.stat{padding:14px 20px}.stat b{font-size:23px}
h2{font-size:16px;font-weight:600;letter-spacing:-.25px;margin:26px 0 10px}
.controls{display:flex;flex-wrap:wrap;gap:12px;align-items:end;padding:14px 0;margin:8px 0 0}
.controls label{display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--mut)}
.controls select{font-size:12px;min-height:32px;min-width:78px}.controls button{font-size:12px;min-height:32px;margin-left:auto}
th,td{padding:9px 12px}td.n{font-size:12px}.bar{display:inline-block;height:5px;border-radius:3px;background:var(--mut);vertical-align:middle}.flag-alert{color:var(--bad);font-weight:600}.flag-watch{color:var(--warn);font-weight:600}.flag-none{color:var(--mut)}.spark svg{display:block;color:var(--mut)}
#tiers-note, .table-wrap + p{font-size:12px;line-height:1.65;max-width:1000px}
footer{margin-top:32px;padding-top:18px;border-top:1px solid var(--line);color:var(--mut);font-size:11px;max-width:1100px}footer p{margin:6px 0}.empty{padding:20px;color:var(--mut)}
@media(max-width:600px){body{padding:0 16px 32px}header{gap:12px;min-height:66px}header nav{gap:14px}.board-heading{align-items:start}.board-heading h1{font-size:23px}.status{margin-top:3px}.controls{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.controls select{width:100%;min-width:0}.controls button{margin:0;grid-column:1/-1}h2{font-size:15px}.board-heading p{font-size:12px}}
`;

export const COMPARISON_SECTIONS = `
<section id="providers" aria-labelledby="providers-heading">
  <div class="section-head"><h2 id="providers-heading">Providers</h2><a href="/board#providers">Compare hosts ↗</a></div>
  <p class="sub">Same weights, different host. Quality, reliability and tool-call errors across providers over the last eight weeks.</p>
  <div id="provider-families" aria-live="polite"><p class="empty">Loading provider comparisons…</p></div>
  <p class="metric-note mut">At least ten sessions per row. Quality is the mean rating out of five; reliability is the share of clean sessions. OpenRouter identifies the router when the underlying host is unknown. Local and modified weights remain separate.</p>
</section>
<section id="friction" aria-labelledby="friction-heading">
  <p class="eyebrow">Friction · last eight weeks</p>
  <div class="section-head"><h2 id="friction-heading">How hard people had to push</h2><a href="/board#friction">Full signals ↗</a></div>
  <p class="sub">Counts derived locally from how the conversation went. No conversation text ever leaves the machine. <a href="/privacy">Privacy details ↗</a></p>
  <div class="table-wrap" tabindex="0" role="region" aria-label="Friction rates, scroll to compare"><table id="friction-table"><thead><tr>
    <th>model</th><th class="n">n</th><th class="n">steering</th><th class="n">corrections</th><th class="n">re-prompts</th><th class="n">frustration</th><th class="n">pushback</th><th class="n" title="Model asked instead of acting">clarifications</th><th class="n">edits without read</th><th class="n">abandoned</th>
  </tr></thead><tbody><tr><td colspan="10" class="empty">Loading conversation signals…</td></tr></tbody></table></div>
  <p class="metric-note mut">Lower is better. Steering = corrections + re-prompts + pushback per user turn. Clarifications count when the model asked instead of acting, per assistant turn; unread edits are per edit; abandonment is per session. These are English-language heuristics, sensitive to tool and reporter habits. “–” means unavailable.</p>
</section>`;

export const COMPARISON_JS = `
const finiteMetric = (v) => typeof v === 'number' && Number.isFinite(v);
const metricNumber = (v, digits = 0) => finiteMetric(v) ? v.toFixed(digits) : '–';
const metricMoney = (v) => finiteMetric(v) ? '$' + v.toFixed(2) : '–';
function steeringRate(row) {
  if (finiteMetric(row.steering)) return row.steering;
  const values = [row.correction_rate, row.reprompt_rate, row.pushback_rate];
  return values.every(finiteMetric) ? values.reduce((a, b) => a + b, 0) : null;
}
function rateBar(v) {
  if (!finiteMetric(v)) return '<span class="mut">–</span>';
  return '<span class="rate" style="--rate:' + Math.max(0, Math.min(100, v * 100)) + '%">' + (v * 100).toFixed(1) + '%</span>';
}
function providerRows(rows) {
  return rows.map((r) => {
    const k = r.key || {};
    const local = k.serving_mode === 'local';
    const modified = r.modified === true || k.modified === true || k.modified === 'true';
    const score = finiteMetric(r.score) ? r.score : null;
    const band = score == null ? 'dash' : score >= 80 ? 'S' : score >= 65 ? 'A' : score >= 50 ? 'B' : 'C';
    const cost = local ? '<span class="mode">local</span><small class="cost-note">' + (finiteMetric(r.hosted_equivalent_per_success) ? metricMoney(r.hosted_equivalent_per_success) + ' hosted-equiv' : '–') + '</small>' : metricMoney(r.cost_per_success);
    return '<tr class="' + (local ? 'local-row ' : '') + (modified ? 'modified-row' : '') + '"><td>' + identity(k.provider) + (modified ? ' <span class="chip">modified weights</span>' : '') + '</td>' +
      '<td><span class="chip mono ' + (!k.quant || k.quant === 'unknown' ? 'mut' : '') + '">' + esc(k.quant || 'unknown') + '</span></td>' +
      '<td><span class="mode">' + esc(k.serving_mode || 'unknown') + '</span></td>' +
      '<td class="n">' + metricNumber(r.n) + '</td><td class="n"><span class="tier ' + band + '">' + metricNumber(score) + '</span></td>' +
      '<td class="n">' + metricNumber(r.rating_mean, 2) + '</td><td class="n">' + rateBar(r.friction_free) + '</td>' +
      '<td class="n tool-error">' + rateBar(r.tool_call_error_rate) + '</td><td class="n">' + (finiteMetric(r.latency_p50_ms) ? (r.latency_p50_ms < 1000 ? Math.round(r.latency_p50_ms) + ' ms' : (r.latency_p50_ms / 1000).toFixed(1) + ' s') : '–') + '</td><td class="n">' + cost + '</td></tr>';
  }).join('');
}
function renderProviders(data, preview = false) {
  const families = Array.isArray(data?.families) ? data.families : [];
  return families.filter(f => Array.isArray(f.rows) && f.rows.length).slice(0, preview ? 3 : undefined).map(f => {
    const buckets = [[], [], [], []];
    for (const r of f.rows) {
      const modified = r.modified === true || r.key?.modified === true || r.key?.modified === 'true';
      buckets[(r.key?.serving_mode === 'local' ? 1 : 0) + (modified ? 2 : 0)].push(r);
    }
    const labels = ['Hosted / plan', 'Local', 'Modified weights · hosted / plan', 'Modified weights · local'];
    const body = buckets.map((rows, i) => rows.length ? '<tbody><tr class="row-group"><th colspan="10" scope="rowgroup">' + labels[i] + '</th></tr>' + providerRows(rows) + '</tbody>' : '').join('');
    return '<article class="family-card"><h3>' + identity(f.family) + (f.display && f.display !== f.family ? '<span class="family-display mut">' + esc(f.display) + '</span>' : '') + (f.open_weights ? '<span class="chip">open weights</span>' : '') + '</h3><div class="table-wrap" tabindex="0" role="region" aria-label="' + esc(f.display || f.family) + ' providers, scroll to compare"><table><thead><tr><th>provider</th><th>quant</th><th>serving mode</th><th class="n">n</th><th class="n">score</th><th class="n">quality / 5</th><th class="n">reliability</th><th class="n tool-error">tool-call error</th><th class="n">p50 latency</th><th class="n">$ / success</th></tr></thead>' + body + '</table></div></article>';
  }).join('') || '<p class="empty">Provider comparisons will appear when a host has ten sessions in this window.</p>';
}
let comparisonRequest = 0;
async function loadComparisons(category = '', preview = false) {
  const request = ++comparisonRequest;
  const suffix = category ? '&category=' + encodeURIComponent(category) : '';
  await Promise.all([
    (async () => {
      let data = null;
      try { const response = await fetch('/v1/providers?weeks=8&min=10' + suffix); if (response.ok) data = await response.json(); } catch {}
      if (request === comparisonRequest) $('#provider-families').innerHTML = renderProviders(data, preview);
    })(),
    (async () => {
      let data = null;
      try { const response = await fetch('/v1/friction?weeks=8' + suffix); if (response.ok) data = await response.json(); } catch {}
      if (request !== comparisonRequest) return;
      const models = Array.isArray(data?.models) ? data.models : [];
      $('#friction-table tbody').innerHTML = models.slice(0, preview ? 5 : undefined).map(r => '<tr><td>' + identity(r.model) + '</td><td class="n" title="' + metricNumber(r.n_signals) + ' sessions with signals">' + metricNumber(r.n) + '</td>' +
        [r.steering, r.correction_rate, r.reprompt_rate, r.frustration_rate, r.pushback_rate, r.clarification_rate, r.edit_without_read_rate, r.abandoned_rate].map(v => '<td class="n">' + rateBar(v) + '</td>').join('') + '</tr>').join('') || '<tr><td colspan="10" class="empty">Conversation signals will appear as sessions are shared.</td></tr>';
    })()
  ]);
}
`;

export const BOARD_JS = `
${IDENTITY_JS}
${COMPARISON_JS}
const $ = (s) => document.querySelector(s);
const fmt = {
  pct: (v) => v == null ? '-' : Math.round(v * 100) + '%',
  num: (v, d = 2) => v == null ? '-' : Number(v).toFixed(d),
  ms: (v) => v == null ? '-' : v < 1000 ? Math.round(v) + 'ms' : (v / 1000).toFixed(1) + 's',
  dur: (s) => s == null ? '-' : s < 90 ? Math.round(s) + 's' : s < 5400 ? Math.round(s / 60) + 'm' : (s / 3600).toFixed(1) + 'h',
  usd: (v) => v == null ? '-' : v < 10 ? '$' + v.toFixed(2) : '$' + Math.round(v),
  tier: (t) => '<span class="tier ' + (t === '-' ? 'dash' : t) + '">' + t + '</span>',
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function qs() {
  const p = new URLSearchParams();
  p.set('by', $('#by').value); p.set('weeks', $('#weeks').value);
  if ($('#cat').value) p.set('category', $('#cat').value);
  if ($('#lang').value) p.set('lang', $('#lang').value);
  return p.toString();
}
async function meta() {
  const m = await (await fetch('/v1/meta')).json();
  $('#meta').textContent = m.reports + ' sessions from ' + m.reporters + (m.reporters === 1 ? ' reporter' : ' reporters');
  $('#s-sessions').textContent = m.reports.toLocaleString();
  $('#s-reporters').textContent = m.reporters.toLocaleString();
  $('#s-models').textContent = m.models.length;
  const week = await (await fetch('/v1/stats?by=week&weeks=1')).json();
  $('#s-week').textContent = week.n.toLocaleString();
  for (const c of m.categories) $('#cat').insertAdjacentHTML('beforeend', '<option>' + esc(c) + '</option>');
  for (const l of m.langs) $('#lang').insertAdjacentHTML('beforeend', '<option>' + esc(l) + '</option>');
}
async function loadTiers() {
  const cat = $('#cat').value;
  const t = await (await fetch('/v1/tiers?weeks=' + $('#weeks').value + (cat ? '&category=' + encodeURIComponent(cat) : ''))).json();
  $('#tiers tbody').innerHTML = t.tiers.map((r) => '<tr>' +
    '<td>' + identity(r.model, r.provider) + '</td>' +
    '<td>' + fmt.tier(r.overall) + '</td>' +
    '<td class="n">' + (r.score ?? '-') + '</td>' +
    ['quality','reliability','steering','survival','speed','value'].map((c) => '<td>' + fmt.tier(r.criteria?.[c]?.tier ?? '-') + ' <span class="mut">' + esc(r.criteria?.[c]?.display ?? '–') + '</span></td>').join('') +
    '<td class="n">' + fmt.pct(r.waste_share) + '</td>' +
    '<td class="n">' + r.n + '</td>' +
  '</tr>').join('') || '<tr><td colspan="11" class="mut">no models with ' + t.min_n + '+ sessions in this window.</td></tr>';
  $('#tiers-note').textContent = 'last ' + t.weeks + ' weeks. tiers need ' + t.min_n + '+ sessions; bands are relative to the best model in the set.';
}
async function loadStats() {
  const r = await (await fetch('/v1/stats?' + qs())).json();
  const by = r.by;
  const head = [...by, 'n', 'score', '', 'rating', 'good [95%]', 'rated', 'surv', 'clean', 'steer', 'tool err', 'p50', 'rate-lim', 'interr', 'switch', '$/sess', '$/success', 'waste', 'dur'];
  $('#score thead').innerHTML = '<tr>' + head.map((h, i) => '<th class="' + (i >= by.length ? 'n' : '') + '">' + esc(h) + '</th>').join('') + '</tr>';
  $('#score tbody').innerHTML = r.groups.map((g) => '<tr>' +
    by.map((b) => '<td>' + (b === 'model' || b === 'family' ? identity(g.key[b], g.provider ?? g.key.provider) : b === 'provider' || b === 'tool' ? identity(g.key[b]) : esc(g.key[b])) + '</td>').join('') +
    '<td class="n">' + g.n + '</td>' +
    '<td class="n">' + (g.score ?? '-') + '</td>' +
    '<td><span class="bar" style="width:' + (g.score ?? 0) * 0.8 + 'px"></span></td>' +
    '<td class="n">' + fmt.num(g.rating_mean) + '</td>' +
    '<td class="n">' + (g.good ? fmt.pct(g.good.p) + ' [' + fmt.pct(g.good.lo) + '-' + fmt.pct(g.good.hi) + ']' : '-') + '</td>' +
    '<td class="n">' + g.n_rated + '</td>' +
    '<td class="n">' + fmt.pct(g.survival_mean) + '</td>' +
    '<td class="n">' + fmt.pct(g.friction_free) + '</td>' +
    '<td class="n">' + rateBar(steeringRate(g)) + '</td>' +
    '<td class="n tool-error">' + rateBar(g.tool_call_error_rate) + '</td>' +
    '<td class="n">' + fmt.ms(g.latency_p50_ms) + '</td>' +
    '<td class="n">' + fmt.pct(g.rate_limit_rate) + '</td>' +
    '<td class="n">' + fmt.pct(g.interrupt_rate) + '</td>' +
    '<td class="n">' + fmt.pct(g.switch_rate) + '</td>' +
    '<td class="n">' + fmt.usd(g.cost_mean) + '</td>' +
    '<td class="n">' + fmt.usd(g.cost_per_success) + '</td>' +
    '<td class="n">' + fmt.pct(g.waste_share) + '</td>' +
    '<td class="n">' + fmt.dur(g.duration_median_s) + '</td>' +
  '</tr>').join('');
  $('#empty').hidden = r.groups.length > 0;
}
async function loadPlans() {
  const p = await (await fetch('/v1/plans?weeks=' + Math.max(12, Number($('#weeks').value)))).json();
  $('#plans tbody').innerHTML = p.plans.map((s) => '<tr>' +
    '<td>' + identity(s.tool, s.provider) + '</td><td>' + esc(s.plan_id) + '</td>' +
    '<td class="n">' + (s.plan_usd_month == null ? 'usage' : '$' + s.plan_usd_month) + '</td>' +
    '<td class="n">' + s.reporters + '</td><td class="n">' + s.reporter_months + '</td>' +
    '<td class="n">' + fmt.num(s.sessions_median, 0) + '</td><td class="n">' + fmt.num(s.successes_median, 0) + '</td>' +
    '<td class="n">' + fmt.num(s.hours_median, 0) + 'h</td>' +
    '<td class="n">' + fmt.usd(s.api_equiv_median) + '</td>' +
    '<td class="n">' + (s.value_multiple_median == null ? '-' : (s.value_multiple_median < 1 ? s.value_multiple_median.toFixed(2) : s.value_multiple_median.toFixed(1)) + 'x') + '</td>' +
    '<td class="n">' + fmt.usd(s.cost_per_success_median) + '</td>' +
    '<td class="n">' + fmt.pct(s.limit_hit_share) + '</td>' +
  '</tr>').join('') || '<tr><td colspan="12" class="mut">no plan data yet. reporters set theirs with: nerfd plan claude claude-max-20x</td></tr>';
}
async function loadDrift() {
  const d = await (await fetch('/v1/drift?weeks=' + $('#weeks').value)).json();
  $('#drift tbody').innerHTML = d.models.map((m) => {
    const dr = m.drift;
    const width = Math.max(1, m.weekly.length) * 9;
    const spark = '<svg width="' + Math.min(144, width) + '" height="26" viewBox="0 0 ' + width + ' 26" role="img" aria-label="Weekly scores, oldest to newest">' + m.weekly.map((w, i) => {
      const height = w.score == null ? 2 : Math.max(2, Math.min(100, w.score) * .24);
      return '<rect x="' + (i * 9) + '" y="' + (26 - height) + '" width="6" height="' + height + '" rx="1.5" fill="currentColor" opacity="' + (w.score == null ? '.25' : '.8') + '"><title>' + esc(w.week) + ': n=' + w.n + ', score=' + (w.score ?? 'unscored') + '</title></rect>';
    }).join('') + '</svg>';
    return '<tr><td>' + identity(m.model, m.provider) + '</td>' +
      '<td class="n">' + (dr ? dr.current.n : '-') + '</td>' +
      '<td class="flag-' + (dr ? dr.flag : 'none') + '">' + (dr ? dr.flag : 'n/a') + '</td>' +
      '<td class="n">' + fmt.num(dr && dr.rating_z, 1) + '</td>' +
      '<td class="n">' + fmt.num(dr && dr.friction_z, 1) + '</td>' +
      '<td class="n">' + fmt.num(dr && dr.latency_z, 1) + '</td>' +
      '<td class="spark">' + spark + '</td></tr>';
  }).join('') || '<tr><td colspan="7" class="mut">need at least two weeks of data per model.</td></tr>';
}
async function load() {
  $('#reload').disabled = true;
  $('#reload').textContent = 'Refreshing…';
  try { await Promise.all([loadTiers(), loadStats(), loadPlans(), loadDrift(), loadComparisons($('#cat').value)]); }
  catch (e) { $('#meta').textContent = 'Unable to refresh. ' + e.message; }
  finally { $('#reload').disabled = false; $('#reload').textContent = 'Refresh'; }
}
for (const id of ['by', 'weeks', 'cat', 'lang']) $('#' + id).addEventListener('change', load);
$('#reload').addEventListener('click', load);
meta().catch(() => { $('#meta').textContent = 'Session totals are unavailable.'; }).finally(load);
`;

export function boardPage(title: string, readOnly: boolean, origin: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
${FAVICON}
<style>${BASE_CSS}</style>
</head>
<body>
<header>
  <a class="brand" href="/"><span class="app-icon" aria-hidden="true">n</span><span>nerfd<em>.ai</em></span></a>
  <nav aria-label="Main navigation">${readOnly ? '' : `<a href="${esc(origin)}/#install">Install</a>`}<a href="/privacy">Privacy</a><a href="/export.json">Raw data</a></nav>
</header>
<main>
<div class="board-heading"><div><h1>${readOnly ? esc(title) : 'The public scorecard'}</h1><p class="mut" id="meta" role="status">Loading session metrics…</p></div><span class="status">${readOnly ? 'Your sessions only' : 'Public record'}</span></div>
${STAT_STRIP}

<div class="controls">
  <label>by<select id="by">
    <option value="model">model</option>
    <option value="model,category">model x category</option>
    <option value="model,lang">model x language</option>
    <option value="model,size">model x task size</option>
    <option value="model,effort">model x effort</option>
    <option value="model,tool">model x tool</option>
    <option value="family">family</option>
    <option value="provider">provider</option>
    <option value="family,provider">family × provider</option>
    <option value="family,provider,quant">family × provider × quant</option>
    <option value="serving_mode">serving mode</option>
    <option value="category">category</option>
  </select></label>
  <label>weeks<select id="weeks"><option>2</option><option selected>4</option><option>8</option><option>12</option><option>26</option></select></label>
  <label>category<select id="cat"><option value="">all</option></select></label>
  <label>lang<select id="lang"><option value="">all</option></select></label>
  <button id="reload">Refresh</button>
</div>

<h2>Model tiers</h2>
<div class="table-wrap" tabindex="0" role="region" aria-label="Scrollable metrics"><table id="tiers"><thead>
<tr><th>model</th><th>tier</th><th class="n">score</th><th>quality</th><th>reliability</th><th>steering</th><th>survival</th><th>speed</th><th>value</th><th class="n">waste</th><th class="n">n</th></tr>
</thead><tbody></tbody></table></div>
<p class="mut" id="tiers-note"></p>

${COMPARISON_SECTIONS}

<h2>Session scorecard</h2>
<div class="table-wrap" tabindex="0" role="region" aria-label="Scrollable metrics"><table id="score"><thead></thead><tbody></tbody></table></div>
<div class="empty" id="empty" hidden>no sessions in this window.</div>

<h2>Subscription value</h2>
<div class="table-wrap" tabindex="0" role="region" aria-label="Scrollable metrics"><table id="plans"><thead>
<tr><th>tool</th><th>plan</th><th class="n">price</th><th class="n">reporters</th><th class="n">months</th><th class="n">sessions</th><th class="n">successes</th><th class="n">hours</th><th class="n">api-equiv</th><th class="n">multiple</th><th class="n">$/success</th><th class="n">hit limit</th></tr>
</thead><tbody></tbody></table></div>
<p class="mut">medians across reporter-months. api-equiv = what the same tokens would cost at API list price. multiple = api-equiv / plan price. $/success = plan price / successful sessions that month. hit limit = share of reporter-months with at least one rate-limit hit.</p>

<h2>Weekly drift</h2>
<div class="table-wrap" tabindex="0" role="region" aria-label="Scrollable metrics"><table id="drift"><thead>
<tr><th>model</th><th class="n">this week n</th><th>flag</th><th class="n">rating z</th><th class="n">clean z</th><th class="n">latency z</th><th>score by week (oldest to newest)</th></tr>
</thead><tbody></tbody></table></div>

</main>
<footer>
  <p><a href="/privacy">Privacy</a></p>
  <p>score = 0.55 x rating + 0.30 x survival + 0.15 x clean. missing parts are dropped and weights renormalised. n &lt; 3 is never scored.</p>
  <p>rating: 1 to 5 from the person who did the work. survival: share of lines the session added that still exist an hour or more later. clean: sessions with no errors, rate limits, interrupts or model switches. success: rated 4+, or kept, or 60%+ survival. waste: spend on sessions rated 2 or less, reverted, or under 20% survival.</p>
  <p>tiers: each criterion normalised to the best model in the set. S &gt;= 92%, A &gt;= 78%, B &gt;= 60%, else C. overall from score: S &gt;= 80, A &gt;= 65, B &gt;= 50.</p>
  <p>drift flags: watch = |z| &gt;= 2, alert = |z| &gt;= 3, and only with n &gt;= 5 this week. this is change detection, not a verdict. <a href="/export.json">raw data</a> &middot; <a href="/v1/stats">api</a></p>
</footer>

<script>${BOARD_JS}</script>
</body>
</html>`;
}

export function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}
