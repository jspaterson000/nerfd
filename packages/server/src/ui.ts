import { RANKINGS_TABLE_JS, RANKINGS_CONTROLS_JS } from '../assets/rankings.ts';
import { designPage } from '../assets/design.ts';
import { READ_GUIDE, READABLE_CSS, READABLE_JS, defineHeaders } from '../assets/presentation.ts';
// Shared inline assets keep the public page and local dashboard in one visual family.
export const FAVICON = `<link rel="icon" href="/assets/logos/nerfd.svg">`;

/** Open Graph and X card tags. One static image for every page; X will not render an SVG. */
export function socialMeta(origin: string, path: string, title: string, description: string): string {
  const url = esc(origin + path);
  return `<meta property="og:type" content="website">
<meta property="og:site_name" content="nerfd.ai">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${esc(origin)}/assets/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(origin)}/assets/og.png">`;
}

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
// Every model name on a board is a door to its own page.
function modelLink(id, inner) { return '<a class="model-link" href="/model/' + encodeURIComponent(id) + '">' + (inner || identity(id)) + '</a>'; }
const WORK_NAMES = { code: 'writing code', debug: 'debugging', refactor: 'refactoring', review: 'review and explanation', ux: 'UI and styling', strategy: 'planning and architecture', writing: 'docs and prose', research: 'research', ops: 'infra and shell work', other: 'unclassified work' };
function workName(c) { return WORK_NAMES[c] || c; }
`;

// Best at each kind of work: one card per category, shared by the landing
// page and the board. Same tiering as the table, run inside each category.
export const WORK_JS = `
function renderWorkCards(data, preview = false) {
  const cards = Array.isArray(data?.work) ? data.work : [];
  const minN = data?.min_n ?? 10;
  const tierOf = (t) => '<span class="tier ' + (!t || t === '-' ? 'dash' : t) + '">' + (t || '–') + '</span>';
  return cards.slice(0, preview ? 6 : undefined).map(c => {
    const ranked = c.ranked.filter(r => r.tier !== '-');
    const list = (ranked.length ? ranked : c.ranked).slice(0, 3).map(r => '<li>' + tierOf(r.tier) + modelLink(r.model) + '<span class="n">' + (r.score == null ? '' : r.score + ' · ') + 'n=' + r.n + '</span></li>').join('');
    return '<article class="work-card"><h3>' + esc(workName(c.category)) + '</h3><p class="meta">' + c.n + ' session' + (c.n === 1 ? '' : 's') + ' · ' + c.n_models + ' model' + (c.n_models === 1 ? '' : 's') + (ranked.length ? '' : ' · none with ' + minN + '+ sessions yet') + '</p><ol>' + list + '</ol><a class="more" href="/board?category=' + encodeURIComponent(c.category) + '#tiers-section">Filter the board to ' + esc(workName(c.category)) + ' ↗</a></article>';
  }).join('') || '<p class="empty">Cards appear as sessions are classified by kind of work. Categories are inferred from the conversation on the reporter’s machine.</p>';
}
`;


// The landing page and board intentionally use identical scales and definitions.
export const LIMITS_SECTION = `
<section id="limits" aria-labelledby="limits-heading">
  <h2 id="limits-heading">What a plan actually gives you</h2>
  <p class="sub">Measured from real sessions: how many tokens a window holds, how much people use, how often they hit the wall, and what that costs per dollar. Bands, not points; every estimate carries its n.</p>
  <p class="metric-note mut">Last eight weeks · USD · ranked by median tokens per dollar</p>
  <div id="limits-content" aria-live="polite"><p class="empty">No window data yet. Codex sessions and Claude Code with the status-line sampler populate this.</p></div>
</section>`;

export const LIMITS_JS = `
(() => {
  const finite = v => typeof v === 'number' && Number.isFinite(v);
  const safe = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const count = v => finite(v) ? Math.round(v).toLocaleString('en-US') : '–';
  const decimal = v => finite(v) ? v.toLocaleString('en-US', {maximumSignificantDigits:3}) : '–';
  const tokens = v => {
    if (!finite(v)) return '–';
    const unit = v >= 1e9 ? [1e9,'B'] : v >= 1e6 ? [1e6,'M'] : v >= 1e3 ? [1e3,'K'] : [1,''];
    return Number((v / unit[0]).toFixed(1)) + unit[1];
  };
  const money = v => finite(v) ? '$' + (v < 10 ? v.toFixed(2) : Math.round(v)) : '–';
  const percent = v => finite(v) ? Math.round(v) + '%' : '–';
  const band = b => b && finite(b.p25) && finite(b.p75) ? tokens(b.p25) + '–' + tokens(b.p75) : '–';
  const windowName = (r, per = false) => {
    const minutes = r.window_min;
    const label = minutes === 300 ? '5 h' : minutes === 10080 ? '7 d' : finite(minutes) && minutes > 0 ? (minutes % 1440 === 0 ? minutes / 1440 + ' d' : minutes % 60 === 0 ? minutes / 60 + ' h' : minutes + ' min') : r.scope === 'spend' ? 'spend' : 'unknown window';
    return per ? (minutes === 300 ? 'per 5h' : minutes === 10080 ? 'per week' : 'per ' + label) : label;
  };
  const empty = '<p class="empty">No window data yet. Codex sessions and Claude Code with the status-line sampler populate this.</p>';
  const table = (title, headers, rows) => '<h3>' + title + '</h3><div class="table-wrap" tabindex="0" role="region" aria-label="' + title + ', scroll to compare"><table><thead><tr>' + headers.map(h => '<th scope="col">' + h + '</th>').join('') + '</tr></thead><tbody>' + rows.join('') + '</tbody></table></div>';
  const row = values => '<tr>' + values.map(v => '<td>' + v + '</td>').join('') + '</tr>';
  const usage = v => finite(v) ? '<span class="limit-usage"><i aria-hidden="true" style="width:' + Math.max(0, Math.min(100, v)) + '%"></i></span><span class="mono">' + percent(v) + '</span>' : '–';
  const wall = v => '<span class="limit-wall' + (finite(v) && v > .3 ? ' high' : '') + '">' + percent(finite(v) ? v * 100 : null) + '</span>';
  const planIdentity = p => {
    const key = ({'claude-code':'anthropic',codex:'openai',opencode:'opencode',kimi:'moonshotai',gemini:'google'})[p.tool];
    return '<span class="identity"><span class="logo">' + (key ? '<img src="/assets/logos/' + key + '.svg" alt="" width="18" height="18" onerror="this.hidden=true;this.nextElementSibling.hidden=false">' : '') + '<span class="logo-fallback"' + (key ? ' hidden' : '') + '>·</span></span><span>' + safe(p.name || p.plan_id || 'Unknown plan') + '</span></span>';
  };
  function scatter(plans) {
    const points = plans.filter(p => finite(p.successes_per_dollar) && p.successes_per_dollar >= 0 && finite(p.quality));
    if (!points.length) return '<p class="empty">The quality comparison appears when successes per dollar and quality are both measured.</p>';
    const max = Math.max(.01, ...points.map(p => p.successes_per_dollar)) * 1.15;
    const maxN = Math.max(1, ...points.map(p => finite(p.n) ? p.n : 0));
    const dots = points.map((p, i) => {
      const x = 58 + p.successes_per_dollar / max * 574;
      const y = 212 - Math.max(0, Math.min(100, p.quality)) * 1.8;
      const r = 4 + 10 * Math.sqrt(Math.max(0, finite(p.n) ? p.n : 0) / maxN);
      return '<g><title>' + safe(p.name || p.plan_id) + ': ' + decimal(p.successes_per_dollar) + ' successes / dollar; quality ' + count(p.quality) + '; n=' + count(p.n) + ' sessions</title><circle cx="' + x + '" cy="' + y + '" r="' + r + '" fill="var(--mut)" fill-opacity=".22" stroke="var(--fg)"/><text x="' + x + '" y="' + (y + 3) + '" text-anchor="middle" font-size="9" fill="var(--fg)">' + (i + 1) + '</text></g>';
    }).join('');
    return '<figure class="limit-scatter"><svg viewBox="0 0 680 268" role="img" aria-label="Plan quality versus successful sessions per dollar. Dot area increases with session count; numbered labels identify plans below."><text x="58" y="16">Quality / 100</text>' + [0,50,100].map(q => '<path d="M58 ' + (212-q*1.8) + 'H632" stroke="var(--line)"/><text x="47" y="' + (216-q*1.8) + '" text-anchor="end">' + q + '</text>').join('') + '<path d="M58 32V212" stroke="var(--line)"/>' + [0,.5,1].map(t => '<text x="' + (58+t*574) + '" y="233" text-anchor="middle">' + decimal(t*max) + '</text>').join('') + dots + '<text x="345" y="259" text-anchor="middle">Successful sessions / dollar</text></svg><figcaption>Generosity only counts when the tokens were worth having. Dot size reflects n sessions.</figcaption><ol class="limit-key">' + points.map(p => '<li>' + planIdentity(p) + ' <span class="mut">n=' + count(p.n) + '</span></li>').join('') + '</ol></figure>';
  }
  function render(data) {
    const plans = (Array.isArray(data?.plans) ? data.plans : []).filter(p => p && typeof p === 'object').slice().sort((a,b) => (finite(b.tokens_per_dollar?.p50) ? b.tokens_per_dollar.p50 : -1) - (finite(a.tokens_per_dollar?.p50) ? a.tokens_per_dollar.p50 : -1));
    const windows = (Array.isArray(data?.windows) ? data.windows : []).filter(w => w && typeof w === 'object');
    if (!plans.length && !windows.length) return empty;
    const scale = Math.max(1, ...plans.flatMap(p => [p.tokens_per_dollar?.p25, p.tokens_per_dollar?.p50, p.tokens_per_dollar?.p75].filter(finite)));
    const position = v => Math.max(0, Math.min(100, v / scale * 100));
    const bars = p => {
      const b = p.tokens_per_dollar;
      if (!b || !finite(b.p25) || !finite(b.p75)) return '<span class="mut">Band unavailable</span>';
      return '<span class="limit-band" role="img" aria-label="Tokens per dollar: p25 ' + tokens(b.p25) + ', median ' + tokens(b.p50) + ', p75 ' + tokens(b.p75) + '"><i style="left:' + position(b.p25) + '%;width:' + Math.max(0, position(b.p75)-position(b.p25)) + '%"></i>' + (finite(b.p50) ? '<b style="left:' + position(b.p50) + '%"></b>' : '') + '</span><span class="mono">' + band(b) + '</span><small class="limit-detail">p50 ' + tokens(b.p50) + ' · ' + windowName(p, true) + '</small>';
    };
    const ranked = plans.length ? table('Plans · tokens per dollar', ['Rank / plan','USD / month','Tokens / dollar · p25–p75','Usage median','Wall-hit share','Successes / dollar','Quality','Evidence'], plans.map((p,i) => {
      const tier = !finite(p.quality) ? 'dash' : p.quality >= 80 ? 'S' : p.quality >= 65 ? 'A' : p.quality >= 50 ? 'B' : 'C';
      return row(['<span class="mut">' + (i+1) + '.</span> ' + planIdentity(p), money(p.usd_month), bars(p), usage(p.usage_median_pct), wall(p.wall_hit_share), decimal(p.successes_per_dollar), '<span class="tier ' + tier + '">' + (tier === 'dash' ? '–' : tier) + '</span>' + count(p.quality), '<span class="mono">n=' + count(p.n) + '</span><small class="limit-detail">' + count(p.n_windows) + ' windows · ' + count(p.reporter_weeks) + ' reporter-weeks</small>']);
    })) : empty;
    const capacity = windows.length ? table('Capacity by window · estimates', ['Plan','Window / scope','Total tokens · p25–p75','Uncached + output · p25–p75','Usage median','Wall hits','n windows','<span title="one person counts once per week, by design: ids rotate weekly so sessions cannot be linked across weeks">n reporter-weeks</span>'], windows.map(w => {
      const p = plans.find(p => p.plan_id === w.plan_id);
      return row([safe(p?.name || w.plan_id || 'Unknown plan'), windowName(w) + '<small class="limit-detail">' + safe(w.scope || 'unknown') + '</small>', band(w.capacity_total), band(w.capacity_uncached), usage(w.usage_median_pct), wall(w.wall_hit_share), count(w.n_windows), count(w.n_reporters)]);
    })) : empty;
    return ranked + '<p class="metric-note mut">Bands are p25–p75, with the median marked on one shared scale. Tokens per dollar extrapolates the selected window to a month. Wall-hit share counts reporter-weeks with a hit; successes exclude wall and context-limit hits. Quality: S ≥ 80 · A ≥ 65 · B ≥ 50 · C &lt; 50.</p>' + capacity + '<p class="metric-note mut">Capacity is estimated, including cached input in total tokens. Uncached is input plus output. Usage and wall hits in this table describe the qualifying windows only; n counts those windows and reporters.</p><h3>Generosity and quality</h3>' + scatter(plans);
  }
  let request = 0;
  async function loadLimits(weeks = 8) {
    const current = ++request;
    let data = null;
    try { const response = await fetch('/v1/limits?weeks='+weeks); if (response.ok) data = await response.json(); } catch {}
    if (current === request) { window.nerfdAnswers('limits', data); document.getElementById('limits-content').innerHTML = data?render(data):'<p class="empty">Usage-limit results could not be loaded. Use Refresh to try again.</p>'; }
  }
  window.nerfdLoadLimits=loadLimits;
  if(!document.getElementById('rankings-app')){loadLimits();document.getElementById('reload')?.addEventListener('click',()=>loadLimits());}
})();
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
.section-head{display:flex;align-items:baseline;justify-content:flex-start;gap:16px}.section-head>:last-child{margin-left:auto}.section-head a{font-size:12px;color:var(--mut)}
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
#limits h3{font-size:13px;font-weight:600;margin:24px 0 10px}#limits .sub{max-width:780px}.limit-detail{display:block;font-size:10px;color:var(--mut);margin-top:4px}.limit-band{display:block;position:relative;width:170px;height:12px;margin:3px 0 7px;background:var(--soft);border-radius:3px}.limit-band i{position:absolute;top:3px;height:6px;background:var(--mut);opacity:.45;border-radius:2px}.limit-band b{position:absolute;top:0;width:2px;height:12px;background:var(--fg);transform:translateX(-1px)}.limit-usage{display:inline-block;width:36px;height:4px;background:var(--soft);margin-right:7px;vertical-align:middle;border-radius:2px;overflow:hidden}.limit-usage i{display:block;height:100%;background:var(--mut)}.limit-wall{padding:3px 5px;border-radius:4px}.limit-wall.high{color:var(--bad);background:color-mix(in srgb,var(--bad) 9%,transparent)}.limit-scatter{max-width:680px;margin:0}.limit-scatter svg{display:block;width:100%;height:auto;font:11px var(--mono);fill:var(--mut)}.limit-scatter figcaption{font-size:12px;color:var(--mut)}.limit-key{display:flex;flex-wrap:wrap;gap:8px 30px;padding-left:24px;font-size:11px}.limit-key li{padding-left:2px}.limit-key .logo{width:22px;height:22px}.limit-key .logo img{width:15px;height:15px}
.eyebrow{font-size:11px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--mut)}
.work-chips{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0 4px}.work-chips button{font-size:12px;padding:6px 12px;border-radius:20px}.work-chips button[aria-pressed="true"]{background:var(--fg);color:var(--bg);border-color:var(--fg)}.work-chips button small{color:inherit;opacity:.7;margin-left:6px;font-family:var(--mono);font-size:10px}
.work-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px;margin-top:8px}.work-card{padding:16px 18px;border:1px solid var(--line);border-radius:12px;background:var(--panel)}.work-card h3{font-size:14px;margin:0 0 2px;font-weight:600;text-transform:capitalize}.work-card .meta{font-size:11px;color:var(--mut);margin:0 0 10px}.work-card ol{margin:0;padding:0;list-style:none}.work-card li{display:flex;align-items:center;gap:8px;padding:7px 0;border-top:1px solid var(--line);font-size:12px}.work-card li .tier{margin:0}.work-card li .model-link{min-width:0;flex:1}.work-card li .n{font-size:11px;color:var(--mut);white-space:nowrap}.work-card .more{display:block;margin-top:10px;font-size:11px;color:var(--mut)}
.model-link:hover{text-decoration:none}.model-link .identity>span:nth-child(2){text-decoration:underline;text-underline-offset:3px;text-decoration-color:var(--line)}.model-link:hover .identity>span:nth-child(2){text-decoration-color:var(--fg)}
.hidden-control{display:none!important}
@media(max-width:600px){.stats{grid-template-columns:repeat(2,minmax(0,1fr))}.stat{padding:16px 18px}.stat:nth-child(2){border-right:0}.stat:nth-child(-n+2){border-bottom:1px solid var(--line)}.stat b{font-size:24px}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
`;

export const STAT_STRIP = `<div class="stats" aria-label="At a glance">
<div class="stat"><b id="s-sessions">–</b><span><svg viewBox="0 0 18 18" aria-hidden="true"><rect x="2" y="3" width="14" height="12" rx="3"/><path d="m5 7 2 2-2 2m5 0h3"/></svg>Sessions</span></div>
<div class="stat" title="one person counts once per week, by design: ids rotate weekly so sessions cannot be linked across weeks"><b id="s-reporters">–</b><span><svg viewBox="0 0 18 18" aria-hidden="true"><circle cx="7" cy="6" r="2.5"/><path d="M2 15v-1a5 5 0 0 1 10 0v1m0-11a2.5 2.5 0 0 1 0 5m2 2a4 4 0 0 1 2 4"/></svg>Reporter-weeks</span></div>
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
${LIMITS_SECTION}
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
  if(!data)return '<p class="empty">Provider results could not be loaded. Use Refresh to try again.</p>';
  const families = Array.isArray(data?.families) ? data.families : [];
  return families.filter(f => Array.isArray(f.rows) && f.rows.length).slice(0, preview ? 3 : undefined).map(f => {
    const buckets = [[], [], [], []];
    for (const r of f.rows) {
      const modified = r.modified === true || r.key?.modified === true || r.key?.modified === 'true';
      buckets[(r.key?.serving_mode === 'local' ? 1 : 0) + (modified ? 2 : 0)].push(r);
    }
    const labels = ['Hosted / plan', 'Local', 'Modified weights · hosted / plan', 'Modified weights · local'];
    const body = buckets.map((rows, i) => rows.length ? '<tbody><tr class="row-group"><th colspan="10" scope="rowgroup">' + labels[i] + '</th></tr>' + providerRows(rows) + '</tbody>' : '').join('');
    return '<article class="family-card"><h3>' + identity(f.family) + (f.display && f.display !== f.family ? ' <span class="family-display mut">' + esc(f.display) + '</span>' : '') + (f.open_weights ? '<span class="chip">open weights</span>' : '') + '</h3><div class="table-wrap" tabindex="0" role="region" aria-label="' + esc(f.display || f.family) + ' providers, scroll to compare"><table><thead><tr><th>provider</th><th>quant</th><th>serving mode</th><th class="n">n</th><th class="n">score</th><th class="n">quality / 5</th><th class="n">reliability</th><th class="n tool-error">tool-call error</th><th class="n">p50 latency</th><th class="n">$ / success</th></tr></thead>' + body + '</table></div></article>';
  }).join('') || '<p class="empty">Provider comparisons will appear when a host has ten sessions in this window.</p>';
}
let comparisonRequest = 0;
async function loadComparisons(category = '', preview = false, weeks = 8) {
  const request = ++comparisonRequest;
  const suffix = category ? '&category=' + encodeURIComponent(category) : '';
  await Promise.all([
    (async () => {
      let data = null;
      try { const response = await fetch('/v1/providers?weeks='+weeks+'&min=10' + suffix); if (response.ok) data = await response.json(); } catch {}
      if (request === comparisonRequest) { window.nerfdAnswers('providers', data); $('#provider-families').innerHTML = renderProviders(data, preview); }
    })(),
    (async () => {
      let data = null;
      try { const response = await fetch('/v1/friction?weeks='+weeks + suffix); if (response.ok) data = await response.json(); } catch {}
      if (request !== comparisonRequest) return;
      window.nerfdAnswers('friction', data);
      const models = Array.isArray(data?.models) ? data.models : [];
      $('#friction-table tbody').innerHTML = models.slice(0, preview ? 5 : undefined).map(r => '<tr><td>' + modelLink(r.model) + '</td><td class="n" title="' + metricNumber(r.n_signals) + ' sessions with signals">' + metricNumber(r.n) + '</td>' +
        [r.steering, r.correction_rate, r.reprompt_rate, r.frustration_rate, r.pushback_rate, r.clarification_rate, r.edit_without_read_rate, r.abandoned_rate].map(v => '<td class="n">' + rateBar(v) + '</td>').join('') + '</tr>').join('') || '<tr><td colspan="10" class="empty">'+(data?'No conversation signals recorded in this view.':'Conversation signals could not be loaded. Use Refresh to try again.')+'</td></tr>';
    })()
  ]);
}
`;

export const BOARD_JS = `
${IDENTITY_JS}
${WORK_JS}
${COMPARISON_JS}
${LIMITS_JS}
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
 try{const response=await fetch('/v1/meta');if(!response.ok)return;const m=await response.json();
 for(const lang of m.langs??[])$('#lang').insertAdjacentHTML('beforeend','<option>'+esc(lang)+'</option>');
 const wanted=new URLSearchParams(location.search).get('lang');if(wanted&&m.langs.includes(wanted)){$('#lang').value=wanted;if(activeView==='evidence')loadStats();}
 }catch{}
}
const extraRequests={work:0,stats:0,plans:0,drift:0};
async function loadWork() {
  const request=++extraRequests.work;
  const w = await (await fetch('/v1/work?weeks=' + $('#weeks').value)).json();
  if(request!==extraRequests.work)return;
  window.nerfdAnswers('work', w);
  $('#work-cards').innerHTML = renderWorkCards(w);
}
${RANKINGS_TABLE_JS}
async function loadStats() {
  const request=++extraRequests.stats;
  const r = await (await fetch('/v1/stats?' + qs())).json();
  if(request!==extraRequests.stats)return;
  window.nerfdAnswers('score', r);
  const by = r.by;
  const head = [...by, 'n', 'score', '', 'rating', 'good [95%]', 'rated', 'surv', 'clean', 'steer', 'tool err', 'p50', 'rate-lim', 'overload', 'interr', 'switch', '$/sess', '$/success', 'waste', 'dur'];
  $('#score thead').innerHTML = '<tr>' + head.map((h, i) => '<th class="' + (i >= by.length ? 'n' : '') + '">' + esc(h) + '</th>').join('') + '</tr>';
  $('#score tbody').innerHTML = r.groups.map((g) => '<tr>' +
    by.map((b) => '<td>' + (b === 'model' ? modelLink(g.key[b], identity(g.key[b], g.provider ?? g.key.provider)) : b === 'family' ? identity(g.key[b], g.provider ?? g.key.provider) : b === 'provider' || b === 'tool' ? identity(g.key[b]) : b === 'category' ? esc(workName(g.key[b])) : esc(g.key[b])) + '</td>').join('') +
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
    '<td class="n">' + fmt.pct(g.overloaded_rate) + '</td>' +
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
  const request=++extraRequests.plans;
  const p = await (await fetch('/v1/plans?weeks=' + Math.max(12, Number($('#weeks').value)))).json();
  if(request!==extraRequests.plans)return;
  window.nerfdAnswers('plans', p);
  $('#plans tbody').innerHTML = p.plans.map((s) => '<tr>' +
    '<td>' + identity(s.tool, s.provider) + '</td><td>' + esc(s.plan_id) + '</td>' +
    '<td class="n">' + (s.plan_usd_month == null ? 'usage' : '$' + s.plan_usd_month) + '</td>' +
    '<td class="n">' + (s.reporter_weeks ?? s.reporters) + '</td><td class="n">' + s.reporter_months + '</td>' +
    '<td class="n">' + fmt.num(s.sessions_median, 0) + '</td><td class="n">' + fmt.num(s.successes_median, 0) + '</td>' +
    '<td class="n">' + fmt.num(s.hours_median, 0) + 'h</td>' +
    '<td class="n">' + fmt.usd(s.api_equiv_median) + '</td>' +
    '<td class="n">' + (s.value_multiple_median == null ? '-' : (s.value_multiple_median < 1 ? s.value_multiple_median.toFixed(2) : s.value_multiple_median.toFixed(1)) + 'x') + '</td>' +
    '<td class="n">' + fmt.usd(s.cost_per_success_median) + '</td>' +
    '<td class="n">' + fmt.pct(s.limit_hit_share) + '</td>' +
  '</tr>').join('') || '<tr><td colspan="12" class="mut">no plan data yet. reporters set theirs with: nerfd plan claude claude-max-20x</td></tr>';
}
async function loadDrift() {
  const request=++extraRequests.drift;
  const d = await (await fetch('/v1/drift?weeks=' + $('#weeks').value)).json();
  if(request!==extraRequests.drift)return;
  window.nerfdAnswers('drift', d);
  $('#drift tbody').innerHTML = d.models.map((m) => {
    const dr = m.drift;
    const width = Math.max(1, m.weekly.length) * 9;
    const spark = '<svg width="' + Math.min(144, width) + '" height="26" viewBox="0 0 ' + width + ' 26" role="img" aria-label="Weekly scores, oldest to newest">' + m.weekly.map((w, i) => {
      const height = w.score == null ? 2 : Math.max(2, Math.min(100, w.score) * .24);
      return '<rect x="' + (i * 9) + '" y="' + (26 - height) + '" width="6" height="' + height + '" rx="1.5" fill="currentColor" opacity="' + (w.score == null ? '.25' : '.8') + '"><title>' + esc(w.week) + ': n=' + w.n + ', score=' + (w.score ?? 'unscored') + '</title></rect>';
    }).join('') + '</svg>';
    return '<tr><td>' + modelLink(m.model, identity(m.model, m.provider)) + '</td>' +
      '<td class="n">' + (dr ? dr.current.n : '-') + '</td>' +
      '<td class="flag-' + (dr ? dr.flag : 'none') + '">' + (dr ? dr.flag : 'n/a') + '</td>' +
      '<td class="n">' + fmt.num(dr && dr.rating_z, 1) + '</td>' +
      '<td class="n">' + fmt.num(dr && dr.friction_z, 1) + '</td>' +
      '<td class="n">' + fmt.num(dr && dr.latency_z, 1) + '</td>' +
      '<td class="spark">' + spark + '</td></tr>';
  }).join('') || '<tr><td colspan="7" class="mut">need at least two weeks of data per model.</td></tr>';
}
${RANKINGS_CONTROLS_JS}
`;

export function boardPage(title: string, readOnly: boolean, origin: string): string {
  const categories=[['code','Coding'],['debug','Debugging'],['review','Review'],['ux','UI & design'],['refactor','Refactoring'],['strategy','Planning'],['writing','Documentation'],['research','Research'],['ops','Infrastructure'],['other','Other work']];
  return designPage(defineHeaders(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rankings · ${esc(title)}</title><meta name="description" content="Compare AI coding models by task, quality, reliability, steering, speed and value, using community results.">${FAVICON}${readOnly ? '' : socialMeta(origin,'/board','AI model rankings · nerfd','Compare models on real coding work. Filter by task, choose a measurement and inspect the results.')}<style>${BASE_CSS}${READABLE_CSS}</style></head><body><header></header><main id="rankings-app" tabindex="-1">
<div class="rankings-title"><h1>${readOnly ? esc(title) : 'Rankings'}</h1><span id="meta" role="status">Loading results…</span><button type="button" class="method-link" popovertarget="rankings-help">How rankings work <span aria-hidden="true">↗</span></button></div>
<nav class="ranking-tabs" role="tablist" aria-label="Ranking views">${[['models','Models'],['providers','Providers'],['plans','Plans'],['changes','Changes'],['evidence','Evidence']].map(([id,label],i)=>`<button type="button" role="tab" id="tab-${id}" aria-controls="view-${id}" aria-selected="${i===0}" tabindex="${i===0?0:-1}" data-view="${id}">${label}</button>`).join('')}</nav>
<div class="ranking-toolbar">
<label id="work-filter">Work type<select id="cat"><option value="">All work</option>${categories.map(([id,label])=>`<option value="${id}">${label}</option>`).join('')}</select></label>
<div id="metric-filter"><span class="control-label">Rank by</span><select id="rank-metric" aria-label="Rank by"><option value="score">Overall score</option><option value="quality">Human rating</option><option value="reliability">Reliability</option><option value="steering">Least steering</option><option value="survival">Code survival</option><option value="speed">Response time</option><option value="value">Cost per success</option><option value="sessions">Most evidence</option><option value="name">Model name</option></select><div class="comparison-switcher" role="group" aria-label="Choose a comparison">${[['score','Overall'],['quality','Quality'],['reliability','Reliability'],['steering','Steering'],['survival','Code kept'],['speed','Speed'],['value','Value']].map(([id,label])=>`<button type="button" data-compare="${id}" aria-pressed="${id==='score'}">${label}</button>`).join('')}</div></div>
<label>Period<select id="weeks">${[2,4,8,12,26].map(w=>`<option value="${w}"${w===4?' selected':''}>${w} weeks</option>`).join('')}</select></label>
<label class="table-search" id="search-filter"><span class="sr-only">Search models</span><input id="rank-search" type="search" placeholder="Search models…" autocomplete="off"></label>
<button id="reload" type="button" aria-label="Refresh results" title="Refresh results">↻</button>
</div>
<p id="view-error" role="alert" hidden></p>
<section id="view-models" role="tabpanel" aria-labelledby="tab-models" tabindex="0" class="ranking-panel">
<div class="table-caption"><span id="rank-count" role="status">Loading rankings…</span><span id="rank-direction"></span><button type="button" id="clear-filters" hidden>Clear filters</button><details class="column-menu"><summary>Columns</summary><div>${[['quality','Human rating'],['reliability','Reliability'],['steering','Steering'],['survival','Code survival'],['speed','Response time'],['value','Cost per success']].map(([id,label])=>`<label><input type="checkbox" value="${id}" data-extra-column> ${label}</label>`).join('')}<button type="button" id="reset-columns">Reset to recommended</button></div></details></div>
<div class="table-wrap rankings-table-wrap" tabindex="0" role="region" aria-label="Model rankings"><table id="tiers" data-managed="true"><thead></thead><tbody><tr><td class="empty">Loading rankings…</td></tr></tbody></table></div>
<details id="pending-models" class="pending-models" hidden><summary id="pending-summary">Models needing more evidence</summary><ul id="pending-list"></ul></details>
<p class="ranking-note" id="tiers-note"></p>
</section>
<section id="view-providers" role="tabpanel" aria-labelledby="tab-providers" tabindex="0" class="ranking-panel" hidden><div id="providers" class="panel-content"><h2>Compare hosting providers</h2><p class="sub">Compare the same model and quantisation across hosts. Results use the selected task and period.</p><div id="provider-families"><p class="empty">Loading providers…</p></div></div></section>
<section id="view-plans" role="tabpanel" aria-labelledby="tab-plans" tabindex="0" class="ranking-panel" hidden><div id="plans-section" class="panel-content"><h2>Subscription value</h2><p class="sub">All work in the selected period. API-equivalent value estimates token cost; it is not cash saved.</p><div class="table-wrap" tabindex="0" role="region" aria-label="Scrollable metrics"><table id="plans"><thead>
<tr><th>tool</th><th>plan</th><th class="n">price</th><th class="n" title="one person counts once per week, by design: ids rotate weekly so sessions cannot be linked across weeks">reporter-weeks</th><th class="n">months</th><th class="n">sessions</th><th class="n">successes</th><th class="n">hours</th><th class="n">api-equiv</th><th class="n">multiple</th><th class="n">$/success</th><th class="n">hit limit</th></tr>
</thead><tbody></tbody></table></div>
<p class="mut">medians across reporter-weeks, plan price pro-rata. api-equiv = what the same tokens would cost at API list price. multiple = api-equiv / plan price. $/success = plan price / successful sessions that month. hit limit = share of reporter-weeks with at least one rate-limit hit.</p>

</div>${LIMITS_SECTION.replace('Last eight weeks','Selected period').replace('last eight weeks','selected period')}</section>
<section id="view-changes" role="tabpanel" aria-labelledby="tab-changes" tabindex="0" class="ranking-panel" hidden><div id="drift-section" class="panel-content"><h2>Weekly changes</h2><p class="sub">All work in the selected period. A flag marks a change from a model’s recent results; it does not establish the cause.</p><div class="table-wrap" tabindex="0" role="region" aria-label="Scrollable metrics"><table id="drift"><thead>
<tr><th>model</th><th class="n">this week n</th><th>flag</th><th class="n">rating z</th><th class="n">clean z</th><th class="n">latency z</th><th>score by week (oldest to newest)</th></tr>
</thead><tbody></tbody></table></div>

</div></section>
<section id="view-evidence" role="tabpanel" aria-labelledby="tab-evidence" tabindex="0" class="ranking-panel" hidden><div id="score-section" class="panel-content"><h2>Detailed session evidence</h2><p class="sub">Dig into the session-level evidence. Group rows and filter by language here; these controls apply to this table.</p><div class="score-controls">  <label>Group evidence by<select id="by">
    <option value="model">Model</option>
    <option value="model,category">Model × task</option>
    <option value="model,lang">Model × language</option>
    <option value="model,size">Model × task size</option>
    <option value="model,effort">Model × reasoning effort</option>
    <option value="model,tool">Model × tool</option>
    <option value="family">Family</option>
    <option value="provider">Provider</option>

    <option value="family,provider">Family × provider</option>
    <option value="family,provider,quant">Family × provider × quant</option>
    <option value="serving_mode">Serving mode</option>
    <option value="category">Task</option>
  </select></label>  <label>Language<select id="lang"><option value="">all</option></select></label></div>
<div class="table-wrap" tabindex="0" role="region" aria-label="Scrollable metrics"><table id="score"><thead></thead><tbody></tbody></table></div>
<div class="empty" id="empty" hidden>no sessions in this window.</div>

</div><div id="friction" class="panel-content"><h2>Conversation signals</h2><p class="sub">Corrections and repeated requests are measured locally. Rates depend on the task, tool and person.</p><div class="table-wrap"><table id="friction-table"><thead><tr><th>model</th><th>sessions</th><th>steering</th><th>corrections</th><th>re-prompts</th><th>frustration</th><th>pushback</th><th>clarifications</th><th>edits without read</th><th>abandoned</th></tr></thead><tbody></tbody></table></div></div><section id="work" aria-labelledby="work-heading">
<h2 id="work-heading">Best at each kind of work</h2>
<p class="sub">Overview of all task categories in the selected period. Choose a task to open its model rankings.</p>
<div class="work-grid" id="work-cards"><p class="empty">Loading kinds of work…</p></div>
<p class="metric-note mut">Kind of work is inferred from the conversation on the reporter’s machine and can be corrected with <span class="mono">nerfd rate</span>. A card ranks models with ten or more sessions on that work; the rest are listed with their n.</p>
</section>

</section>
<aside id="rankings-help" popover class="rankings-help"><button type="button" popovertarget="rankings-help" popovertargetaction="hide" aria-label="Close ranking explanation">×</button><h2>How rankings work</h2><p>Scores combine human ratings (55%), code survival (30%) and clean sessions (15%). Missing inputs are excluded and the remaining weights are adjusted.</p><p>Public ranks require 10 sessions per model; local ranks require 3. A score without ratings is not a human assessment of quality.</p><p>Steering, speed and cost are separate comparisons. Lower is better for these measurements. Different tasks, tools and people affect results.</p><a href="https://github.com/jspaterson000/nerfd/blob/main/docs/METHOD.md">Read the full method ↗</a></aside>
</main><footer class="ranking-footer"><a href="/privacy">Privacy</a><a href="/export.json">Download data ↗</a><span>${readOnly?'Your local results':'Community results · human-directed sessions'}</span></footer>
<script>${ANSWER_JS}</script><script>${READABLE_JS}</script><script>${BOARD_JS}</script></body></html>`),readOnly);
}

export function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

// Answer builders only consume the existing endpoint responses. Never infer ratings
// from an unrated composite, or unique reporters from rotating reporter-week IDs.
const ANSWER_JS = `
(() => {
 const state = {};
 const number = v => typeof v === 'number' && Number.isFinite(v);
 const count = v => number(v) ? v.toLocaleString('en-US', {maximumFractionDigits:1}) : 'not measured';
 const set = (id, text) => { const el = document.getElementById(id + '-answer'); if(el) el.textContent = text; };
 window.nerfdAnswers = (kind, data) => {
   state[kind] = data;
   if (kind === 'tiers') {
     const rows = data?.tiers || []; const top = rows.filter(r => number(r.score)).sort((a,b) => b.score-a.score)[0];
     const rated = rows.filter(r => r.criteria?.quality?.tier && r.criteria.quality.tier !== '-');
     state.quality = !rows.length ? 'No model has enough sessions for a public tier yet.' : !rated.length ? 'Not enough rated sessions yet to rank quality; scores below use clean sessions and measured code survival only.' : rated.length < rows.length ? 'Ratings cover only part of this field; composite scores use the observations available for each model.' : 'Quality ratings are available; compare like tasks before choosing a model.';
     const scope = data?.category ? 'For ' + (typeof workName === 'function' ? workName(data.category) : data.category) + ', ' : '';
     set('tiers', scope + (scope ? state.quality.charAt(0).toLowerCase() + state.quality.slice(1) : state.quality) + (top ? ' ' + top.model + ' has the highest composite score, ' + count(top.score) + '/100 (n=' + count(top.n) + '), in this ' + count(data.weeks || 4) + '-week field.' : ' Tiers appear after ' + count(data?.min_n || 10) + ' sessions per model.'));
   }
   if(kind === 'work') {
     const cards = (data?.work || []); const led = cards.filter(c => c.ranked.some(r => r.tier !== '-'));
     set('work', led.length ? count(led.length) + ' kinds of work have enough evidence to compare models.' + (cards.length > led.length ? ' ' + count(cards.length - led.length) + ' more kind' + (cards.length - led.length === 1 ? '' : 's') + ' of work have sessions but no model with enough of them to rank.' : '') : cards.length ? count(cards.length) + ' kinds of work have sessions, but no model has reached the ' + count(data?.min_n || 10) + ' sessions a per-task rank needs.' : 'No classified work yet. Categories are inferred from the conversation on the reporter’s machine.');
   }
   if(kind === 'score') {
     const rows = data?.groups || []; const rated = rows.reduce((s,r) => s + (r.n_rated || 0),0); const n = rows.reduce((s,r) => s + (r.n || 0),0);
     set('score', rows.length ? count(rated) + ' of ' + count(n) + ' sessions have a rating in this grouping. ' + (rated < 3 ? 'Too few ratings to rank quality; use the clean-session and code-survival evidence below.' : 'Compare scores within the same task and tool; missing inputs are reweighted.') : 'No sessions match these filters. Widen the time window or choose all tasks and languages.');
   }
   if(kind === 'providers') {
     const families = data?.families || []; const comparable = families.filter(f => (f.rows || []).filter(r => r.n >= 10).length >= 2);
     set('providers', !families.length ? 'No host comparison yet. Shared sessions must identify the model family and provider; the board needs ten sessions per row.' : count(families.length) + ' model families are recorded; ' + count(comparable.length) + ' have at least two serving variants with ten sessions each. ' + (comparable.length ? 'Compare the same quantisation and task before attributing a difference to the host.' : 'A single host is evidence of use, not a head-to-head comparison.'));
   }
   if(kind === 'limits') {
     const windows = data?.windows || []; const w = windows.find(w => w.window_min === 10080 && number(w.capacity_total?.p50)) || windows.find(w => number(w.capacity_total?.p50));
     set('limits', w ? (w.window_min === 10080 ? 'A weekly' : 'A ' + count(w.window_min / 60) + '-hour') + ' window for ' + w.plan_id + ' holds about ' + count(w.capacity_total.p50) + ' total tokens; the middle half spans ' + count(w.capacity_total.p25) + '–' + count(w.capacity_total.p75) + ' (n=' + count(w.n_windows) + ' windows). Typical usage is ' + count(w.usage_median_pct) + '%.' : 'No capacity estimate yet. Codex usage readings or the Claude Code status-line sampler must cover enough of a window to estimate its size.');
   }
   if(kind === 'friction') {
     const rows = (data?.models || []).filter(r => number(r.steering) && (r.n_signals ?? r.n) >= 3).sort((a,b) => a.steering-b.steering); const r = rows[0];
     set('friction', r ? r.model + ' has the lowest observed steering rate: ' + count(r.steering*100) + '% (n=' + count(r.n_signals ?? r.n) + ' sessions with signals). This counts extra direction, not quality; tool and reporter habits affect it.' : 'Too few conversation signals to compare effort yet. Supported tools record corrections and repeated requests locally when sessions finish.');
   }
   if(kind === 'plans') {
     const plans = data?.plans || []; const p = plans.filter(p => number(p.api_equiv_median)).sort((a,b) => b.reporters-a.reporters)[0];
     set('plans', p ? p.plan_id + ' recorded a median $' + count(p.api_equiv_median) + ' of API-equivalent token use per reporter-week (n=' + count(p.reporter_weeks ?? p.reporters) + ' reporter-weeks). ' + (number(p.cost_per_success_median) ? 'Measured successes cost $' + count(p.cost_per_success_median) + ' each at the period-adjusted plan price.' : 'Cost per success needs a measured successful outcome and plan price.') : 'No priced plan comparison yet. Record the plan and token usage to see what the subscription delivered.');
   }
   if(kind === 'drift') {
     const models = data?.models || []; const flags = models.filter(m => ['watch','alert'].includes(m.drift?.flag)); const eligible = models.filter(m => m.drift);
     set('drift', eligible.length ? count(flags.length) + ' of ' + count(eligible.length) + ' comparable models have a change flag against their trailing baseline. A flag asks for a closer look; it is not a verdict.' : 'Not enough weekly history to measure change. A flag needs a baseline and at least five sessions this week.');
   }
   const m = state.meta;
   set('glance', (m ? count(m.reports) + ' sessions across ' + count(m.models?.length || 0) + ' models are in this record (' + count(m.reporter_weeks ?? m.reporters) + ' reporter-weeks, not unique people). ' : 'Session totals are still loading or unavailable. ') + (state.week ? count(state.week.n) + ' sessions were recorded this week. ' : '') + (state.quality || 'Quality rankings need rated sessions. ') + ' Open a section for evidence and sample sizes.');
 };
})();
`;

export function readablePublic(source: string, landing: boolean): string {
  let html = source;
  const answer = (id: string, text = 'Loading the observations for this section; if unavailable, refresh to try again.'): string => `<p class="answer" id="${id}-answer" aria-live="polite">${text}</p>`;
  // Give formerly unsectioned tables stable section anchors without moving IDs.
  if (landing) {
    html = html.replace('<section>\n  <div class="section-head"><h2>Tiers', '<section id="tiers-section">\n  <div class="section-head"><h2>Tiers');
    html = html.replace('<section>\n  <h2>What a month actually buys', '<section id="plans-section">\n  <h2>Subscription value');
    const glance = html.match(/  <div class="glance">[\s\S]*?<\/div>\n<\/div>/)?.[0];
    if (glance) html = html.replace(glance, '</div>');
    const panel = `<div class="glance-panel"><h2>This week in one look</h2>${answer('glance', 'Loading this week’s record. Ratings, measured outcomes and sample sizes will explain what can be compared.')}${STAT_STRIP}</div>${READ_GUIDE}`;
    html = html.replace('  <div class="install" id="install">', panel + '<h2>Make your next session count</h2><p class="sub">Install once for a personal report of what worked, what it cost and where work got harder.</p><div class="install" id="install">');
    html = html.replace('The public record of how AI models actually perform on real work.</h1>', 'Which AI is working for you?</h1>');
    html = html.replace(/<p class="lede">[\s\S]*?<\/p>/, '<p class="lede">See what worked, what your plan bought, and how much direction each model needed. Start with your own sessions; compare the public evidence as it grows.</p>');
  } else {
    html = html.replace(STAT_STRIP, `<div class="record-overview">${STAT_STRIP}<details class="record-context"><summary>About this record</summary>${answer('glance')}</details></div>${READ_GUIDE}`);
    for (const [title, id, end] of [['Model rankings','tiers-section','${COMPARISON_SECTIONS}'], ['Session scorecard','score-section','<h2>Subscription value</h2>'], ['Subscription value','plans-section','<h2>Weekly drift</h2>'], ['Weekly drift','drift-section','</main>']]) {
      html = html.replace(`<h2>${title}</h2>`, `<section id="${id}"><h2>${title}</h2>`);
      if (title === 'Model rankings') { /* closed in the markup, before the work section */ }
      else html = html.replace(end, '</section>' + end);
    }
    html = html.replace('<footer>', '<footer id="method"><h2>Method</h2>');
  }
  const sections = [['tiers-section','Model rankings','tiers'],['work','Task fit','work'],['providers','Hosting providers','providers'],['limits','Usage limits','limits'],['friction','Human effort','friction'], ...(!landing ? [['score-section','Detailed evidence','score']] : []),['plans-section','Subscription value','plans'], ...(!landing ? [['drift-section','Weekly change','drift']] : []), ['method','Method','method']];
  const nav = `<nav class="section-nav" aria-label="Sections">${sections.map(([id, label], i) => `<a href="#${id}">${String(i+1).padStart(2,'0')} ${label}</a>`).join('')}</nav>`;
  html = html.replace(landing ? '\n<section id="tiers-section">' : '<div class="controls">', nav + (landing ? '\n<section id="tiers-section">' : '<div class="controls">'));
  sections.forEach(([id, title, key], i) => {
    const start = html.indexOf(`id="${id}"`); if(start < 0) return;
    const h2 = html.indexOf('<h2', start); if(h2 < 0) return;
    const close = html.indexOf('</h2>', h2) + 5;
    const marker = `<span class="section-number">${String(i+1).padStart(2,'0')}</span>`;
    html = html.slice(0,h2) + marker + html.slice(h2,close) + answer(key, key === 'method' ? 'Your sessions produce local counts; sharing sends redacted metrics, never prompts or code.' : undefined) + html.slice(close);
  });
  // Answer paragraphs belong below the section heading row, not inside its flex layout.
  html = html.replace(/(<div class="section-head">[\s\S]*?<\/h2>)(<p class="answer"[\s\S]*?<\/p>)([\s\S]*?<\/div>)/g, '$1$3$2');
  if (landing) {
    for (const [id] of sections) {
      if(id === 'method') continue;
      const start = html.indexOf(`id="${id}"`); const end = html.indexOf('</section>', start);
      if(start < 0 || end < 0) continue;
      let part = html.slice(start,end).replace(/href="\/board(?:#[^"]*)?"/g, `href="/board#${id}"`);
      if(!part.includes('href="/board')) part += `<p class="section-context"><a href="/board#${id}">Explore this evidence on the board ↗</a></p>`;
      html = html.slice(0,start) + part + html.slice(end);
    }
  }
  html = html.replace('</style>', READABLE_CSS + '\n.glance-panel .stats{grid-template-columns:repeat(3,minmax(0,1fr))}.glance-panel .stat:nth-child(2){display:none}.glance-panel .stat{padding:16px}.glance-panel .stat b{font-size:24px}\n</style>');
  html = html.replace('<script>', () => `<script>${ANSWER_JS}</script><script>${READABLE_JS}</script><script>`);
  return defineHeaders(html);
}
