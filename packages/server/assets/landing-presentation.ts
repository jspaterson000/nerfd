// Landing-only presentation. Illustrations are examples, never live observations.
export const PROMISES = `<section class="promises" aria-labelledby="promises-heading">
<p class="eyebrow">Your sessions. Your answers.</p><h2 id="promises-heading">Three reasons to keep it installed.</h2>
<div class="promise-grid">
<article class="promise-card"><a href="/model" class="promise-link">
<div class="preview"><div class="preview-top"><span>Model over time</span><span class="chip">Example</span></div>
<svg class="timeline-preview" viewBox="0 0 280 145" role="img" aria-label="Example timeline: a model drops in week 36 while the field stays steady. Week 36 has 24 sessions and a change flag.">
<g stroke="var(--line)" fill="none"><path d="M12 28H268M12 65H268M12 102H268"/><path d="M12 54L62 51L112 56L162 52L212 57L268 53" stroke-dasharray="3 5"/></g>
<path class="timeline-line" d="M12 39L62 33L112 40L162 35L212 88L268 94" fill="none" stroke="var(--accent)" stroke-width="2.5" pathLength="1"/>
<path d="M212 35V106" stroke="var(--mut)" stroke-dasharray="2 4"/><circle class="flag-dot" cx="212" cy="88" r="5" fill="var(--accent)"/>
<g fill="var(--mut)" font-size="10"><text x="12" y="128">W32</text><text x="192" y="128">W36</text><text x="175" y="20">watch · n=24</text></g></svg>
<div class="preview-key"><span>━ Model</span><span>┄ Whole field</span></div></div>
<h3>Is it you, or the model?</h3><p>A page per model with the week it moved, tested against its own last four weeks and against the whole field. Change detection, with the numbers.</p><span class="card-cta">One model, over time ↗</span></a></article>
<article class="promise-card"><a href="/board#limits" class="promise-link">
<div class="preview"><div class="preview-top"><span>ChatGPT Pro · $200 / mo</span><span class="chip">Example</span></div><div class="preview-multiple">12.4<span>×</span></div><p class="preview-note">API-equivalent / period plan cost · n=48</p><div class="limit-band" role="img" aria-label="Example: 2.1 to 3.8 million tokens per five-hour window; median 2.9 million"><i style="left:22%;width:54%"></i><b style="left:47%"></b></div><div class="preview-key"><span>2.1–3.8M tokens / 5h</span><span>n=16 windows</span></div><p class="preview-note">Estimated value, not cash saved.</p></div>
<h3>What did your $200 buy?</h3><p>Sessions, hours, API-equivalent value, tokens per window, how often the wall hit. Your own report in one command.</p><span class="card-cta">See what a plan gives you ↗</span></a></article>
<article class="promise-card"><a href="/board#work" class="promise-link">
<div class="preview"><div class="preview-top"><span>Best at each kind of work</span><span class="chip">Example</span></div><div class="mini-work">
<div class="work-card"><span>Debugging</span><span class="tier S">S</span><span class="mono">84 · n=32</span></div>
<div class="work-card"><span>UI and styling</span><span class="tier A">A</span><span class="mono">76 · n=18</span></div>
<div class="work-card"><span>Review</span><span class="tier S">S</span><span class="mono">89 · n=41</span></div></div><p class="preview-note">Different work. Different leaders.</p></div>
<h3>Which model, for which work.</h3><p>Best at debugging, best at UI, best at review. From real sessions on real repos, not a benchmark.</p><span class="card-cta">Find your kind of work ↗</span></a></article>
</div></section>`;

export function terminalDemo(command: string): string {
  return `<section class="own-data" aria-labelledby="own-heading"><div><p class="eyebrow">Start with the work you already did</p><h2 id="own-heading">See it on your own data</h2><p class="sub">Your models. Your plan. Your report.</p><p class="demo-caption">Hooks into Claude Code, Codex, OpenCode, Gemini CLI, Qwen Code, Kimi Code, Goose, Crush and Copilot CLI. Backfills the history they already wrote.</p></div>
<figure class="terminal-demo"><figcaption class="preview-top"><span>Terminal → your report</span><span class="chip">Example session</span></figcaption>
<div class="terminal-body"><p class="terminal-line demo-install"><span class="mut">$ </span><code>${command}</code></p><p class="terminal-line demo-report"><span class="mut">$ </span><code>nerfd report</code></p>
<div class="demo-output" role="img" aria-label="Illustrative report rows and score bars; no conversation text"><div><i></i><b style="--bar:82%"></b></div><div><i></i><b style="--bar:64%"></b></div><div><i></i><b style="--bar:73%"></b></div></div><p class="demo-done mono">report written to ~/.nerfd/report.html</p></div></figure></section>`;
}

export const TRUST = `<section class="trust" aria-labelledby="trust-heading"><p class="eyebrow">The evidence is yours to inspect</p><h2 id="trust-heading">Why you can trust the numbers</h2><div class="trust-grid">
<article><span class="trust-mark mono">n ≥ 10</span><h3>Never a bare average.</h3><p>Every number carries its n. Rates carry a 95% interval. Fewer than three sessions is never scored; a public tier needs ten.</p></article>
<article><span class="trust-mark mono">{ counts }</span><h3>Counts, never conversations.</h3><p>Prompts, code, paths and repo names never leave the machine. <a href="/privacy">The privacy page shows the exact record.</a> <code>nerfd share off</code> is one command.</p></article>
<article><span class="trust-mark mono">CC BY 4.0</span><h3>Open collector, open data, open formula.</h3><p>The score line is in the footer. The dataset is CC BY 4.0. The code is on GitHub: <a href="https://github.com/jspaterson000/nerfd">github.com/jspaterson000/nerfd</a>.</p></article>
<article><span class="trust-mark mono">$0 from labs</span><h3>No money from model labs, ever.</h3><p>Every evaluator that took lab money ended up ranking its customers. This one cannot.</p></article>
</div></section>`;

export const FOUNDERS_FAQ = `<section class="founding" aria-labelledby="founders-heading"><div><p class="eyebrow">Your report becomes a public good</p><h2 id="founders-heading">Founding reporters</h2><p class="sub">The first month's reporters, by choice. <code>nerfd founder @handle</code> adds yours; the data stays pseudonymous either way.</p><ol id="founders" class="founders"></ol><noscript>Be the first.</noscript><a class="roadmap-link" href="https://github.com/jspaterson000/nerfd#roadmap">Public roadmap ↗</a></div><div class="founder-count"><b id="s-reporters">–</b><span>reporter-weeks</span><p>One person contributing in one week.<br>A growing record you can check.</p></div></section>
<section class="faq" aria-labelledby="faq-heading"><p class="eyebrow">Before you install</p><h2 id="faq-heading">A few reasonable questions.</h2>
<details><summary>What leaves my machine?</summary><p>Derived session metrics: model, tool, plan, category, token and event counts, timing and outcome measurements. Prompts, code, file paths and repo names stay local. <code>nerfd privacy</code> shows the record and endpoint. <code>nerfd share off</code> stops sharing. <a href="/privacy">Read the exact record.</a></p></details>
<details><summary>Can my employer see this?</summary><p>There is no organisation enrolment, admin console or person lookup. On a managed laptop, your employer may access the local database and observe network traffic. Public records contain derived metrics and a pseudonymous reporter ID; they are not a guarantee against re-identification.</p></details>
<details><summary>Does it slow my tools down?</summary><p>Hooks collect counts locally. Session-end processing parses existing history and hashes the diff, so there is some overhead. The SessionEnd hook has a 30-second timeout. There is no measured overhead guarantee.</p></details>
<details><summary>I run models locally with Ollama, does it work?</summary><p>Yes, through a supported coding tool such as OpenCode or Goose. Model, provider, quantisation and local serving mode stay separate in the board. Local value uses a notional hosted equivalent, not a bill for running the model.</p></details>
<details><summary>How are tiers computed?</summary><p>Criterion tiers compare each model with the best in the same field: S ≥ 92%, A ≥ 78%, B ≥ 60%, C below 60%. Overall tiers use the composite score: S ≥ 80, A ≥ 65, B ≥ 50. Public tiers require 10 sessions. Missing score inputs are dropped and the remaining weights are renormalised. <a href="#how">Read how the tables rank.</a></p></details>
<details><summary>Who pays for this?</summary><p>Money from model labs is excluded: no sponsorship, data deal or grant. The funding options in the plan are a data API, an enterprise view, non-lab sponsorship, or no revenue.</p></details>
</section>`;

export const LANDING_CSS = `
:root{--accent:var(--ok);--warn:var(--mut);--bad:var(--mut)}
html{scroll-behavior:auto}.wrap{max-width:1160px}.site-nav{gap:24px}.site-nav .nav-install{color:var(--fg);border:1px solid var(--line);border-radius:7px;padding:5px 12px;background:var(--panel)}
.hero{position:relative;display:grid;grid-template-columns:minmax(0,1.45fr) minmax(300px,1fr);gap:44px;align-items:center;padding:68px 0 32px;background:radial-gradient(ellipse at 85% 38%,color-mix(in srgb,var(--accent) 5%,transparent),transparent 60%)}
.hero .eyebrow{font-size:10px;letter-spacing:.075em;margin-bottom:20px}.hero .eyebrow::before{background:var(--accent);flex:none}h1{font-size:clamp(38px,4.4vw,58px);line-height:1.08;letter-spacing:-2.5px;max-width:650px}.hero .lede{font-size:16px;line-height:1.75;margin-bottom:26px;max-width:610px}.hero .install{margin:0;max-width:100%}.hero .install code{font-size:11px;padding:9px 5px}.hero .install button{padding:8px}.install #cmd{display:block}.live-line{font-size:11px;color:var(--mut);margin:12px 0}.live-line b{font-weight:500;color:var(--fg)}.secondary-ctas{gap:12px 20px;margin-top:20px}.secondary-ctas a:first-child{color:var(--fg)}
.record-card{margin:0;border:1px solid var(--line);background:var(--panel);border-radius:14px;box-shadow:0 18px 50px #00000008;overflow:hidden;min-width:0;transform:rotate(1deg)}.record-caption{padding:14px 18px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;gap:8px;color:var(--mut);font:10px var(--mono)}.record-lines{padding:14px 18px;font:11px/2.2 var(--mono)}.record-line{display:grid;grid-template-columns:70px 1fr auto;gap:7px;align-items:center}.record-key{color:var(--mut)}.record-value{overflow:hidden;white-space:nowrap}.record-line small{color:var(--accent);font:9px var(--mono)}.record-line.private .record-value{opacity:.3;text-decoration:line-through}.record-line.private small{color:var(--mut)}.record-bottom{margin:0;border-top:1px solid var(--line);padding:13px 18px;color:var(--mut);font-size:11px}.record-bottom strong{color:var(--fg);font-weight:500}
.promises{border-top:1px solid var(--line)}.promise-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin-top:26px}.promise-card{border:1px solid var(--line);border-radius:14px;background:var(--panel);overflow:hidden;min-width:0}.promise-link{display:flex;flex-direction:column;height:100%;padding:14px}.promise-link:hover{text-decoration:none}.promise-card h3{font-size:18px;font-weight:600;letter-spacing:-.45px;margin:23px 6px 10px}.promise-card p:not(.preview-note){font-size:13px;color:var(--mut);line-height:1.75;margin:0 6px 20px}.card-cta{font-size:12px;margin:auto 6px 8px;padding-top:6px}.preview{height:235px;padding:15px;background:var(--soft);border:1px solid var(--line);border-radius:8px;overflow:hidden}.preview-top{display:flex;justify-content:space-between;gap:8px;align-items:center;font-size:10px;color:var(--mut)}.preview-top .chip{font-size:8px}.timeline-preview{width:100%;height:148px;margin:6px 0 0;display:block;font-family:var(--mono)}.preview-key{display:flex;justify-content:space-between;gap:8px;font:9px var(--mono);color:var(--mut)}.preview-multiple{font:52px/1.1 var(--mono);letter-spacing:-3px;margin:19px 0 8px}.preview-multiple span{color:var(--mut);font-size:32px}.preview p.preview-note{font-size:9px;line-height:1.5;color:var(--mut);margin:8px 0 12px}.preview .limit-band{width:100%;margin:19px 0 10px;background:var(--line)}.preview .limit-band i{background:var(--accent)}.mini-work{display:grid;gap:7px;margin-top:17px}.mini-work .work-card{display:grid;grid-template-columns:1fr auto auto;align-items:center;gap:6px;padding:9px 8px;font-size:10px;border-radius:6px}.mini-work .tier{font-size:9px;min-width:19px;margin:0}.mini-work .mono{font-size:9px;color:var(--mut)}
.own-data{display:grid;grid-template-columns:1fr 1.4fr;gap:40px;align-items:center}.demo-caption{font-size:12px;line-height:1.8;color:var(--mut);max-width:360px}.terminal-demo{margin:0;min-width:0;border:1px solid var(--line);border-radius:12px;background:var(--panel);overflow:hidden}.terminal-demo figcaption{padding:13px 18px;border-bottom:1px solid var(--line);background:var(--soft)}.terminal-body{padding:22px;font-size:11px}.terminal-line{margin:0 0 14px;overflow-wrap:anywhere}.terminal-line code{display:inline}.demo-output{display:grid;gap:9px;max-width:310px;margin:26px 0}.demo-output>div{display:flex;gap:25px;align-items:center}.demo-output i{width:60px;height:5px;border-radius:3px;background:var(--line)}.demo-output b{height:6px;width:var(--bar);max-width:180px;border-radius:3px;background:var(--accent);opacity:.45}.demo-done{color:var(--mut);font-size:10px;margin:0;overflow-wrap:anywhere}
.trust-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:20px;margin:26px 0 0}.trust-grid article{border-top:1px solid var(--line);padding:20px 0}.trust-mark{color:var(--accent);font-size:11px}.trust-grid h3{font-size:15px;line-height:1.5;margin:17px 0 10px}.trust-grid p{font-size:12px;line-height:1.8;color:var(--mut);margin:0;overflow-wrap:anywhere}.trust-grid a{color:var(--fg);text-decoration:underline;text-underline-offset:3px}
.board-heading{margin-top:58px;padding-top:36px;border-top:1px solid var(--line)}.board-heading .answer{font-size:14px}.board-week{font-size:12px;color:var(--mut)}.board-week b{color:var(--fg)}.section-nav{position:static!important;min-height:0;margin-top:24px;gap:12px}.section-head{flex-wrap:wrap}.section-head .section-number{flex-basis:100%;margin:0}.section-head h2{margin:0}.founding{display:grid;grid-template-columns:1.4fr 1fr;gap:40px;margin-top:50px;border-top:1px solid var(--line)}.founders{display:flex;gap:8px;flex-wrap:wrap;padding:0;list-style:none;font-size:13px}.founders li{border:1px solid var(--line);border-radius:7px;padding:8px 13px;background:var(--panel)}.roadmap-link{font-size:12px;color:var(--mut)}.founder-count{align-self:center;border-left:1px solid var(--line);padding-left:40px}.founder-count b{font:52px/1.2 var(--mono);letter-spacing:-2px;display:block}.founder-count>span{font-size:13px}.founder-count p{font-size:11px;color:var(--mut)}.faq{max-width:820px}.faq details{border-bottom:1px solid var(--line);padding:18px 0}.faq summary{font-size:14px}.faq details p{font-size:13px;color:var(--mut);line-height:1.8;margin:14px 0 0;max-width:740px}.faq a{text-decoration:underline}.footer-formula{flex-basis:100%;font-size:11px;line-height:1.8}.footer-formula code{color:var(--fg)}
@media(prefers-reduced-motion:no-preference){
html{scroll-behavior:smooth}.promise-card,.trust-grid article,.work-card{transition:transform 120ms ease}.promise-card:hover,.trust-grid article:hover,.work-card:hover{transform:translateY(-2px)}
.record-value{animation:record-type .34s steps(12,end) both;animation-delay:calc(var(--i)*.27s)}.record-line small{animation:appear .4s 5.5s both}.record-line.private .record-value{animation:record-type .34s steps(12,end) both,redact 1.1s 4.3s both;animation-delay:calc(var(--i)*.27s),4.3s}
#cmd{animation:type-command 1.8s steps(48,end) both}#copy{animation:appear .3s 1.8s both}#copy:focus-visible{animation:none}
.timeline-preview.in-view .timeline-line{stroke-dasharray:1;animation:draw-line 1.4s ease both}.timeline-preview.in-view .flag-dot{transform-box:fill-box;transform-origin:center;animation:pulse-dot .7s 1.4s ease both}
.terminal-demo.in-view .demo-install{animation:type-command 1.8s steps(48,end) both}.terminal-demo.in-view .demo-report{animation:type-command .7s 2s steps(12,end) both}.terminal-demo.in-view .demo-output{animation:appear .7s 2.9s both}.terminal-demo.in-view .demo-done{animation:appear .4s 3.7s both}
@keyframes record-type{from{clip-path:inset(0 100% 0 0)}to{clip-path:inset(0)}}@keyframes type-command{from{clip-path:inset(0 100% 0 0)}to{clip-path:inset(0)}}@keyframes redact{0%{opacity:1;text-decoration:none}35%{opacity:1;text-decoration:line-through}100%{opacity:.3;text-decoration:line-through}}@keyframes appear{from{opacity:0}to{opacity:1}}@keyframes draw-line{from{stroke-dashoffset:1}to{stroke-dashoffset:0}}@keyframes pulse-dot{0%,100%{transform:scale(1)}50%{transform:scale(1.8)}}
}
@media(max-width:1000px){.hero{gap:25px;grid-template-columns:minmax(0,1.4fr) minmax(280px,1fr)}.hero h1{font-size:45px}.trust-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.promise-grid{gap:10px}.preview{padding:10px}.mini-work .work-card{gap:4px;padding:9px 5px;font-size:9px}.preview-key{font-size:8px}}
@media(max-width:760px){.hero{grid-template-columns:1fr;padding-top:38px;gap:32px}.hero h1{font-size:44px;max-width:570px}.hero .lede{font-size:15px}.record-card{width:100%;max-width:430px;justify-self:center;transform:none}.promise-grid{grid-template-columns:1fr;gap:18px}.promise-link{padding:18px}.preview{height:235px;padding:16px}.promise-card h3{margin-top:22px}.preview-multiple{font-size:48px}.timeline-preview{max-width:400px;margin:auto}.mini-work .work-card{font-size:12px;padding:9px}.preview-key{font-size:10px}.own-data{grid-template-columns:1fr;gap:16px}.demo-caption{max-width:100%}.founding{grid-template-columns:1fr;gap:22px}.founder-count{border-left:0;border-top:1px solid var(--line);padding:24px 0 0}.site-nav{flex-wrap:nowrap;padding:0;gap:18px}.site-nav .brand{flex-basis:auto}.site-nav .sp{display:block}.site-nav .nav-method{display:none}.trust-grid{gap:20px}.section-head{display:flex}.section-head a{margin-left:0}.terminal-body{padding:18px}.live-line{font-size:10px;line-height:1.8}}
@media(max-width:380px){.hero h1{font-size:38px}.hero .eyebrow{font-size:9px}.trust-grid{grid-template-columns:1fr}.site-nav{gap:10px;font-size:11px}.site-nav .brand{font-size:18px}.site-nav .nav-install{padding:5px 8px}.hero .install code{font-size:10px}.hero .install button{font-size:10px}.record-lines{font-size:10px}.record-line{grid-template-columns:63px 1fr auto}.record-line small{font-size:8px}}
`;

export const LANDING_JS = `
const motionPreference = window.matchMedia('(prefers-reduced-motion: no-preference)');
function countUp(id, value) {
  const el = document.getElementById(id);
  if (!el || !Number.isFinite(value)) return;
  const end = Math.max(0, Math.round(value));
  if (!motionPreference.matches) { el.textContent = end.toLocaleString(); return; }
  const start = performance.now();
  const tick = now => {
    const progress = motionPreference.matches ? Math.min(1, (now-start)/850) : 1;
    el.textContent = Math.round(end * (1-Math.pow(1-progress,3))).toLocaleString();
    if (progress < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
if ('IntersectionObserver' in window && motionPreference.matches) {
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => { if (entry.isIntersecting) { entry.target.classList.add('in-view'); observer.unobserve(entry.target); } });
  }, {threshold:.25});
  document.querySelectorAll('.timeline-preview,.terminal-demo').forEach(el => observer.observe(el));
}
(async () => {
  const list = document.getElementById('founders');
  const empty = () => { const li = document.createElement('li'); li.textContent = 'Be the first.'; list.replaceChildren(li); };
  try {
    const response = await fetch('/v1/founders');
    if (!response.ok) throw new Error('Founders unavailable');
    const data = await response.json();
    const founders = Array.isArray(data) ? data : data.founders;
    if (!Array.isArray(founders)) { empty(); return; }
    const handles = [...new Set(founders.map(item => typeof item === 'string' ? item : item?.handle).filter(handle => typeof handle === 'string' && /^@?[A-Za-z0-9_]{1,15}$/.test(handle)))].slice(0,100);
    if (!handles.length) { empty(); return; }
    list.replaceChildren(...handles.map(handle => { const li = document.createElement('li'); li.textContent = handle.startsWith('@') ? handle : '@'+handle; return li; }));
  } catch { empty(); }
})();
`;
