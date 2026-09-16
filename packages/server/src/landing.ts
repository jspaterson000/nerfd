import { esc, FAVICON, SHARED_CSS, IDENTITY_JS, STAT_STRIP } from './ui.ts';

// The public front door. Self-contained HTML using the same visual primitives as the board.

export function landingPage(origin: string): string {
  const install = `curl -fsSL ${origin}/install.sh | sh`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>nerfd.ai — The public record of AI on real work</title>
<meta name="description" content="The public record of how AI models actually perform on real work. Across coding tools and providers, ranked weekly, priced honestly.">
${FAVICON}
<style>${SHARED_CSS}
.wrap{max-width:1080px;margin:auto;padding:0 32px}
nav{display:flex;align-items:center;gap:24px;min-height:76px;border-bottom:1px solid var(--line);font-size:13px;color:var(--mut)}nav .brand{color:var(--fg)}nav .sp{flex:1}
.hero{padding:66px 0 0}.hero .eyebrow{display:flex;align-items:center;gap:8px;margin:0 0 20px}.hero .eyebrow::before{content:"";width:6px;height:6px;background:var(--ok);border-radius:50%}
h1{font-size:47px;line-height:1.12;letter-spacing:-1.9px;font-weight:600;max-width:850px;margin:0 0 22px}
.lede{font-size:17px;line-height:1.7;color:var(--mut);max-width:700px;margin:0 0 25px}
.tools{display:flex;align-items:center;flex-wrap:wrap;gap:10px 18px;margin:0 0 30px;color:var(--mut);font-size:12px}.tools span{display:inline-flex;align-items:center;gap:7px}.tools img{width:18px;height:18px;object-fit:contain}.tools .tool-logo{display:inline-grid;place-items:center;width:25px;height:25px;background:white;border:1px solid var(--line);border-radius:7px}
.install{display:flex;align-items:center;gap:8px;max-width:710px;background:var(--soft);border:1px solid var(--line);border-radius:11px;padding:7px;box-shadow:inset 0 1px 3px #00000004}.install code{flex:1;min-width:0;padding:8px 9px;font-size:13px;overflow-wrap:anywhere}.install button{flex:none;font-size:12px;padding:8px 13px;display:flex;align-items:center;gap:6px}.install button svg{width:14px;height:14px;stroke:currentColor;fill:none;stroke-width:1.4}
.fine{font-size:12px;max-width:720px;margin:12px 0 0;line-height:1.8}.fine code{font-size:11px;color:var(--fg)}.fine a{text-decoration:underline;text-underline-offset:3px}
.glance{margin-top:38px}.glance .eyebrow{margin:0 0 10px;display:block}.glance .eyebrow::before{display:none}
section{padding:45px 0 0}h2{font-size:23px;letter-spacing:-.6px;font-weight:600;margin:0 0 7px}.sub{font-size:14px;margin:0 0 20px;max-width:720px}.section-head{display:flex;align-items:center;justify-content:space-between;gap:16px}.section-head a{font-size:12px;color:var(--mut);white-space:nowrap}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:20px}.cols>div{min-width:0;padding:24px;background:var(--panel);border:1px solid var(--line);border-radius:12px}.cols h3{font-size:14px;margin:0 0 12px;font-weight:600}.cols ul{margin:0;padding-left:17px;color:var(--mut);font-size:13px}.cols li{margin:7px 0}
.cmd{display:block;max-width:100%;background:var(--soft);border:1px solid var(--line);border-radius:8px;padding:12px;font-size:12px;margin:10px 0;white-space:pre-wrap;overflow-wrap:anywhere}
footer{margin:56px 0 0;padding:24px 0 36px;border-top:1px solid var(--line);font-size:12px;color:var(--mut);display:flex;flex-wrap:wrap;gap:12px 22px}
#limits{min-width:0}#limits .table-wrap{max-width:100%;overflow-x:auto}#limits .limit-key li{min-width:0;overflow-wrap:anywhere}#limits .limit-key .identity{white-space:normal}
.model-detail{display:block;font-size:10px;margin-top:3px}
#providers th,#providers td,#friction th,#friction td{padding:10px 12px}
.landing-rate{display:inline-block;min-width:62px;padding:2px 4px;font-size:11px;background:linear-gradient(to right,var(--line) var(--rate),transparent var(--rate)) left center/100% 4px no-repeat}
@media(max-width:480px){nav{flex-wrap:wrap;padding:14px 0;gap:10px 16px}nav .sp{display:none}nav .brand{flex-basis:100%}#providers .section-head,#friction .section-head{flex-wrap:wrap;gap:4px;margin-bottom:10px}}
@media(max-width:720px){.wrap{padding:0 20px}nav{gap:16px;min-height:66px;font-size:12px}nav .optional{display:none}.hero{padding:40px 0 0}h1{font-size:35px;letter-spacing:-1.2px}.lede{font-size:15px}.tools{gap:10px 14px}.cols{grid-template-columns:1fr}.cols>div{padding:20px}.install{align-items:stretch}.install code{font-size:12px;padding:7px}.install button{padding:8px 10px}.glance{margin-top:30px}section{padding-top:34px}h2{font-size:21px}.section-head{align-items:baseline}.section-head a{font-size:11px}}
</style>
</head>
<body>
<div class="wrap">
<nav aria-label="Main navigation">
  <a class="brand" href="/"><span class="app-icon" aria-hidden="true">n</span><span>nerfd<em>.ai</em></span></a>
  <span class="sp"></span>
  <a href="/board">Board</a>
  <a href="#install">Install</a>
  <a href="#providers">Providers</a>
  <a href="#limits">Plans</a>
  <a href="#friction">Friction</a>
  <a class="optional" href="#method">Method</a>
  <a href="/privacy">Privacy</a>
</nav>

<main>
<div class="hero">
  <p class="eyebrow">Real sessions. Measurable outcomes.</p>
  <h1>The public record of how AI models actually perform on real work.</h1>
  <p class="lede">Session reports from developers’ terminals, ranked weekly by outcome. Compare quality, reliability, steering, survival, speed and value. The record covers Claude Code, Codex, OpenCode, Gemini CLI, Qwen Code, Kimi Code, Goose, Crush, Cline, Aider and GitHub Copilot CLI.</p>
  <div class="tools" aria-label="Developer tools">
    <span><span class="tool-logo"><img src="/assets/logos/anthropic.svg" alt="" width="18" height="18"></span>Claude Code</span>
    <span><span class="tool-logo"><img src="/assets/logos/openai.svg" alt="" width="18" height="18"></span>Codex</span>
    <span><span class="tool-logo"><img src="/assets/logos/opencode.svg" alt="" width="18" height="18"></span>OpenCode</span>
    <span><span class="tool-logo"><img src="/assets/logos/google.svg" alt="" width="18" height="18"></span>Gemini CLI</span>
    <span><span class="tool-logo"><img src="/assets/logos/moonshotai.svg" alt="" width="18" height="18"></span>Kimi Code</span>
    <span><span class="tool-logo"><img src="/assets/logos/github.svg" alt="" width="18" height="18"></span>GitHub Copilot CLI</span>
  </div>
  <div class="install" id="install">
    <code class="mono" id="cmd">${esc(install)}</code>
    <button id="copy" type="button" aria-label="Copy install command"><svg viewBox="0 0 18 18" aria-hidden="true"><rect x="6" y="6" width="9" height="10" rx="2"/><path d="M4 12H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v1"/></svg><span aria-live="polite">Copy</span></button>
  </div>
  <p class="fine">Only redacted metrics are sent. <code>nerfd privacy</code> shows exactly what; <code>nerfd share off</code> stops it. <a href="/privacy">Privacy details</a>.</p>
  <div class="glance"><p class="eyebrow">At a glance · public record</p>${STAT_STRIP}</div>
</div>

<section>
  <div class="section-head"><h2>Tiers, last four weeks</h2><a href="/board">Full scorecard ↗</a></div>
  <p class="sub">Relative to the best model in the field on each criterion. A tier needs at least ten sessions. Each badge includes its underlying number.</p>
  <div class="tbl" tabindex="0" role="region" aria-label="Scrollable metrics"><table id="tiers"><thead>
    <tr><th>model</th><th>overall</th><th>quality</th><th>reliability</th><th>steering</th><th>survival</th><th>speed</th><th>value</th><th class="n">waste</th><th class="n">n</th></tr>
  </thead><tbody><tr><td colspan="10" class="mut">loading</td></tr></tbody></table></div>
</section>

<section id="providers" aria-labelledby="providers-heading">
  <div class="section-head"><h2 id="providers-heading">Same weights, different host</h2><a href="/board">Full provider board ↗</a></div>
  <p class="sub">Open models are served by many providers at different quantisations. The scorecard keys on model, provider and quantisation, so they are never averaged together.</p>
  <div id="provider-families" aria-live="polite"><p class="empty">No provider data yet. Open-model sessions from OpenCode, Goose, Kimi Code, Crush and Aider populate this board.</p></div>
</section>

<section id="limits" aria-labelledby="limits-heading">
  <h2 id="limits-heading">What a plan actually gives you</h2>
  <p class="sub">Measured from real sessions: how many tokens a window holds, how much people use, how often they hit the wall, and what that costs per dollar. Bands, not points; every estimate carries its n.</p>
  <p class="metric-note mut">Last eight weeks · USD · ranked by median tokens per dollar</p>
  <div id="limits-content" aria-live="polite"><p class="empty">No window data yet. Codex sessions and Claude Code with the status-line sampler populate this.</p></div>
</section>

<section id="friction" aria-labelledby="friction-heading">
  <div class="section-head"><h2 id="friction-heading">How hard people had to push</h2><a href="/board">Full friction board ↗</a></div>
  <p class="sub">Counts derived on your machine from how the conversation went: corrections, re-prompts, pushback, frustration, clarifying questions. <a href="/privacy">No text ever leaves the machine.</a></p>
  <div class="table-wrap" tabindex="0" role="region" aria-label="Friction rates, scroll to compare"><table id="friction-table"><thead><tr>
    <th>model</th><th class="n">n</th><th class="n">steering %</th><th class="n">corrections %</th><th class="n">re-prompts %</th><th class="n">frustration %</th><th class="n">pushback %</th><th class="n">clarifications %</th><th class="n">edits w/o read %</th><th class="n">abandoned %</th>
  </tr></thead><tbody aria-live="polite"><tr><td colspan="10" class="empty">No friction data yet. Conversation signals will appear as sessions are shared.</td></tr></tbody></table></div>
  <p class="metric-note mut">Lower is better. “–” means unavailable.</p>
</section>

<section>
  <h2>What a month actually buys</h2>
  <p class="sub">The plan is detected from each tool's own config, never typed in. We count what it delivered: successful sessions, hours, the API-equivalent value of the tokens, and how often they reached a rate limit. Medians across reporter-weeks, with the plan price charged pro-rata.</p>
  <div class="tbl" tabindex="0" role="region" aria-label="Scrollable metrics"><table id="plans"><thead>
    <tr><th>plan</th><th class="n">price</th><th class="n">sessions</th><th class="n">successes</th><th class="n">api-equiv</th><th class="n">multiple</th><th class="n">$ / success</th><th class="n">hit limit</th><th class="n">n</th></tr>
  </thead><tbody><tr><td colspan="9" class="mut">loading</td></tr></tbody></table></div>
</section>

<section id="method">
  <h2>How it works</h2>
  <div class="cols">
    <div>
      <h3>Collected automatically, per session</h3>
      <ul>
        <li>model, reasoning effort, tool version, plan tier</li>
        <li>task category (inferred, overridable), task size, repo language and size bucket</li>
        <li>prompts, turns, tool calls, edits, tests run, errors, rate-limit hits, timeouts</li>
        <li>interrupts and mid-session model switches</li>
        <li>token totals and latency percentiles</li>
        <li>code survival: how much of what the session wrote is still there an hour later</li>
      </ul>
    </div>
    <div>
      <h3>Never shared</h3>
      <ul>
        <li>prompts, code, diffs, file paths, repo names</li>
        <li>notes you type, your identity, your email</li>
        <li>anything at all until you run the installer or <span class="mono">nerfd share on</span></li>
      </ul>
      <h3 style="margin-top:18px">Optional, two seconds</h3>
      <span class="cmd mono">/nerfd 4 kept "solid refactor, one retry"</span>
      <p class="mut" style="margin:0;font-size:14px">Works inside Claude Code and Codex. From a shell: <span class="mono">nerfd rate last 4 kept</span>.</p>
    </div>
  </div>
  <div class="cols" style="margin-top:32px">
    <div>
      <h3>Score</h3>
      <span class="cmd mono">score = 0.55·rating + 0.30·survival + 0.15·clean</span>
      <p class="mut" style="font-size:14px;margin:0">Missing parts are dropped and weights renormalised. Fewer than three sessions is never scored. The scorecard shows sample sizes and 95% intervals for the good-session rate.</p>
    </div>
    <div>
      <h3>Drift</h3>
      <p class="mut" style="font-size:14px;margin:0">Each model's current week is compared with its trailing four weeks on rating, clean rate and latency. A flag needs |z| ≥ 2 and five sessions. Effort level and tool version are recorded so a change can be attributed to the harness, not just the weights. This is change detection, not accusation.</p>
    </div>
  </div>
</section>

<section>
  <h2>Other tools</h2>
  <p class="sub">Anything that can run a shell command can report. Same schema, same redaction.</p>
  <span class="cmd mono">nerfd record --tool aider --model gpt-6 --cat debug --duration 840 --rating 4 --kept --tokens-in 120000 --tokens-out 9000</span>
</section>

</main>
<footer>
  <span>open collector, open data, open formula</span>
  <a href="/export.json">raw data</a>
  <a href="/v1/stats">api</a>
  <a href="/board">full board</a>
  <a href="/privacy">privacy</a>
  <span>no money from model labs, ever</span>
</footer>
</div>

<script>
${IDENTITY_JS}
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
    const capacity = windows.length ? table('Capacity by window · estimates', ['Plan','Window / scope','Total tokens · p25–p75','Uncached + output · p25–p75','Usage median','Wall hits','n windows','n reporters'], windows.map(w => {
      const p = plans.find(p => p.plan_id === w.plan_id);
      return row([safe(p?.name || w.plan_id || 'Unknown plan'), windowName(w) + '<small class="limit-detail">' + safe(w.scope || 'unknown') + '</small>', band(w.capacity_total), band(w.capacity_uncached), usage(w.usage_median_pct), wall(w.wall_hit_share), count(w.n_windows), count(w.n_reporters)]);
    })) : empty;
    return ranked + '<p class="metric-note mut">Bands are p25–p75, with the median marked on one shared scale. Tokens per dollar extrapolates the selected window to a month. Wall-hit share counts reporter-weeks with a hit; successes exclude wall and context-limit hits. Quality: S ≥ 80 · A ≥ 65 · B ≥ 50 · C &lt; 50.</p>' + capacity + '<p class="metric-note mut">Capacity is estimated, including cached input in total tokens. Uncached is input plus output. Usage and wall hits in this table describe the qualifying windows only; n counts those windows and reporters.</p><h3>Generosity and quality</h3>' + scatter(plans);
  }
  let request = 0;
  async function loadLimits() {
    const current = ++request;
    let data = null;
    try { const response = await fetch('/v1/limits?weeks=8'); if (response.ok) data = await response.json(); } catch {}
    if (current === request) document.getElementById('limits-content').innerHTML = render(data);
  }
  loadLimits();
  document.getElementById('reload')?.addEventListener('click', loadLimits);
})();
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const usd = (v) => v == null ? '–' : v < 10 ? '$' + v.toFixed(2) : '$' + Math.round(v);
const pct = (v) => v == null ? '–' : Math.round(v * 100) + '%';
const tier = (t, title) => '<span class="tier ' + (t === '-' ? 'dash' : t) + '" title="' + esc(title ?? '') + '">' + t + '</span>';
$('#copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#cmd').textContent); $('#copy span').textContent = 'Copied'; setTimeout(() => $('#copy span').textContent = 'Copy', 1500); } catch { $('#copy span').textContent = 'Select text'; const range = document.createRange(); range.selectNodeContents($('#cmd')); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); }
});
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const number = (v) => finite(v) ? String(v) : '–';
const providerEmpty = '<p class="empty">No provider data yet. Open-model sessions from OpenCode, Goose, Kimi Code, Crush and Aider populate this board.</p>';
const frictionEmpty = '<tr><td colspan="10" class="empty">No friction data yet. Conversation signals will appear as sessions are shared.</td></tr>';
const logoAssets = new Set('kimi-for-coding moonshotai cerebras ollama lmstudio together deepinfra openrouter alibaba minimax-coding-plan anthropic opencode google amazon-bedrock qwen nerfd minimax deepseek mistral fireworks zhipuai zai-coding-plan openai groq vertex xai github zai meta'.split(' '));
function landingIdentity(label, key) {
  const name = String(label || 'Unknown');
  const logo = logoAssets.has(key) ? key : logoFor(key);
  return '<span class="identity"><span class="logo">' + (logo ? '<img src="/assets/logos/' + logo + '.svg" width="18" height="18" alt="" onerror="this.hidden=true;this.nextElementSibling.hidden=false">' : '') + '<span class="logo-fallback"' + (logo ? ' hidden' : '') + '>·</span></span><span>' + esc(name) + '</span></span>';
}
function rate(v) {
  return finite(v) ? '<span class="landing-rate" style="--rate:' + Math.max(0, Math.min(100, v * 100)) + '%">' + (v * 100).toFixed(1) + '%</span>' : '<span class="mut">–</span>';
}
async function comparisonData(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Metrics unavailable');
  return response.json();
}
(async () => {
  const target = $('#provider-families');
  try {
    const data = await comparisonData('/v1/providers?weeks=8');
    const total = (f) => f.rows.reduce((n, r) => n + (finite(r.n) ? r.n : 0), 0);
    target.innerHTML = (Array.isArray(data?.families) ? data.families : []).filter(f => Array.isArray(f.rows) && f.rows.length)
      .sort((a, b) => total(b) - total(a)).slice(0, 4).map(f => {
        const rows = f.rows.map(r => {
          const k = r.key || {};
          const score = finite(r.score) ? r.score : null;
          const band = score == null ? 'dash' : score >= 80 ? 'S' : score >= 65 ? 'A' : score >= 50 ? 'B' : 'C';
          return '<tr><td>' + landingIdentity(k.provider, k.provider) + '<small class="model-detail mut">' + esc(k.model || f.family) + '</small></td>' +
            '<td><span class="chip mono ' + (!k.quant || k.quant === 'unknown' ? 'mut' : '') + '">' + esc(k.quant || 'unknown') + '</span></td>' +
            '<td class="mode">' + esc(k.serving_mode || 'unknown') + '</td><td class="n">' + number(r.n) + '</td>' +
            '<td class="n"><span class="tier ' + band + '">' + (score == null ? '–' : score.toFixed(0)) + '</span></td>' +
            '<td class="n tool-error">' + rate(r.tool_call_error_rate) + '</td>' +
            '<td class="n">' + (finite(r.latency_p50_ms) ? (r.latency_p50_ms < 1000 ? Math.round(r.latency_p50_ms) + ' ms' : (r.latency_p50_ms / 1000).toFixed(1) + ' s') : '–') + '</td>' +
            '<td class="n">' + (k.serving_mode === 'local' ? 'local' : finite(r.cost_per_success) ? usd(r.cost_per_success) : '–') + '</td></tr>';
        }).join('');
        return '<article class="family-card"><h3>' + landingIdentity(f.display || f.family, logoFor(f.family)) + (f.open_weights ? '<span class="chip">open weights</span>' : '') + '</h3>' +
          '<div class="table-wrap" tabindex="0" role="region" aria-label="' + esc(f.display || f.family) + ' providers, scroll to compare"><table><thead><tr><th>provider</th><th>quant</th><th>mode</th><th class="n">n</th><th class="n">score</th><th class="n tool-error">tool-call errors</th><th class="n">p50 latency</th><th class="n">$ / success</th></tr></thead><tbody>' + rows + '</tbody></table></div></article>';
      }).join('') || providerEmpty;
  } catch { target.innerHTML = providerEmpty; }
})();
(async () => {
  const target = $('#friction-table tbody');
  try {
    const data = await comparisonData('/v1/friction?weeks=8');
    target.innerHTML = (Array.isArray(data?.models) ? data.models : []).sort((a, b) => (b.n || 0) - (a.n || 0)).slice(0, 8).map(r =>
      '<tr><td>' + identity(r.model) + '</td><td class="n">' + number(r.n) + '</td>' +
      [r.steering, r.correction_rate, r.reprompt_rate, r.frustration_rate, r.pushback_rate, r.clarification_rate, r.edit_without_read_rate, r.abandoned_rate]
        .map(v => '<td class="n">' + rate(v) + '</td>').join('') + '</tr>').join('') || frictionEmpty;
  } catch { target.innerHTML = frictionEmpty; }
})();
(async () => {
  try {
    const m = await (await fetch('/v1/meta')).json();
    $('#s-sessions').textContent = m.reports.toLocaleString();
    $('#s-reporters').textContent = m.reporters.toLocaleString();
    $('#s-models').textContent = m.models.length;
    const wk = await (await fetch('/v1/stats?by=week&weeks=1')).json();
    $('#s-week').textContent = wk.n.toLocaleString();
    const t = await (await fetch('/v1/tiers?weeks=4')).json();
    $('#tiers tbody').innerHTML = t.tiers.map((r) => '<tr>' +
      '<td class="model">' + identity(r.model, r.provider) + '</td>' +
      '<td>' + tier(r.overall, 'score ' + (r.score ?? '–')) + '<span class="mut">' + (r.score ?? '') + '</span></td>' +
      ['quality','reliability','steering','survival','speed','value'].map((c) => '<td>' + tier(r.criteria?.[c]?.tier ?? '-', r.criteria?.[c]?.display ?? '–') + '<span class="mut">' + esc(r.criteria?.[c]?.display ?? '–') + '</span></td>').join('') +
      '<td class="n">' + pct(r.waste_share) + '</td>' +
      '<td class="n">' + r.n + '</td></tr>').join('') || '<tr><td colspan="10" class="mut">no model has ' + t.min_n + ' sessions yet. be the first: run the installer.</td></tr>';
    const p = await (await fetch('/v1/plans?weeks=12')).json();
    $('#plans tbody').innerHTML = p.plans.map((s) => '<tr>' +
      '<td>' + identity(s.plan_id, s.provider) + ' <span class="mut">' + esc(s.tool) + '</span></td>' +
      '<td class="n">' + (s.plan_usd_month == null ? 'usage' : '$' + s.plan_usd_month) + '</td>' +
      '<td class="n">' + (s.sessions_median ?? '–') + '</td>' +
      '<td class="n">' + (s.successes_median ?? '–') + '</td>' +
      '<td class="n">' + usd(s.api_equiv_median) + '</td>' +
      '<td class="n">' + (s.value_multiple_median == null ? '–' : (s.value_multiple_median < 1 ? s.value_multiple_median.toFixed(2) : s.value_multiple_median.toFixed(1)) + "×") + '</td>' +
      '<td class="n">' + usd(s.cost_per_success_median) + '</td>' +
      '<td class="n">' + pct(s.limit_hit_share) + '</td>' +
      '<td class="n">' + s.reporters + '</td></tr>').join('') || '<tr><td colspan="9" class="mut">no plan data yet. reporters set theirs with <span class="mono">nerfd plan claude claude-max-20x</span>.</td></tr>';
  } catch (e) { console.error(e); for (const id of ['tiers', 'plans']) if ($('#' + id + ' tbody').textContent.trim() === 'loading') $('#' + id + ' tbody').innerHTML = '<tr><td colspan="' + (id === 'tiers' ? 10 : 9) + '" class="mut">Unable to load metrics. Please refresh to try again.</td></tr>'; }
})();
</script>
</body>
</html>`;
}
