// Inline presentation primitives shared by the public pages and offline report.
// No requests, libraries, or report data are introduced here.
const definitions: [string, string, string][] = [
  ['^rank$', 'Rank is the position among models with enough sessions in this field, by composite score; 1 is best.', 'Needs the minimum session count to rank.'],
  ['^work$|^best in this work|best at', 'The kind of work, inferred from the conversation on the reporter’s machine; nerfd rate can correct it.', 'No sessions on this kind of work yet.'],
  ['^moved$', 'Metrics that shifted |z| ≥ 2 from the trailing four weeks; worse always means worse, whichever direction the metric runs.', 'Nothing moved measurably this week.'],
  ['field score', 'The composite score of every model that week on the same formula, so a dip shared by the field is not one model’s.', 'No other sessions that week.'],
  ['tools · effort|^tools$', 'Which tools and reasoning-effort levels ran the model that week; a harness change looks like a weights change from here.', 'Not recorded.'],
  ['^n signals', 'Sessions with conversation signals, the denominator for the friction rates.', 'No sessions with signals.'],
  [' z$|^flag$', 'Drift compares the current week with a trailing baseline; watch needs |z| ≥ 2, alert ≥ 3, and five current-week sessions.', 'Need enough current and baseline weeks to measure change.'],
  ['reporter|evidence', 'One reporter-week is one person contributing in one week; rotating IDs cannot identify unique people across weeks.', 'No reporting weeks recorded.'],
  ['n windows', 'Number of observed or qualifying usage windows, as labelled beside the table.', 'No qualifying windows yet.'],
  ['n sessions|^n$|sample|this week n|^sessions$', 'Number of sessions behind this row; this is not the number of ratings.', 'No sessions in this window.'],
  ['surv', 'Code survival is the share of added lines still present at least an hour later.', 'Run nerfd check after an hour to measure code survival.'],
  ['steer', 'Steering counts corrections, re-prompts and pushback per user turn; lower is better.', 'No conversation signals with usable turn counts recorded.'],
  ['clean|reliability|friction-free', 'Clean sessions have no errors, rate limits, interrupts or model switches; higher is better.', 'No clean-session observations in this group.'],
  ['quality|rating|rated', 'Quality is the optional human rating from 1 to 5; higher is better.', 'No qualifying ratings yet; run /nerfd 4 kept after a session.'],
  ['^good|^success', 'Success means rated 4+, kept, or at least 60% code survival; 95% brackets show uncertainty where available.', 'No measured successes yet; rate a session or run nerfd check.'],
  ['wall|hit limit|limit hit', 'A wall hit means a subscription limit stopped work; shares count windows or reporter-weeks as labelled, and lower is better.', 'No limit observations recorded for this window.'],
  ['usage|peak', 'Usage is the percentage of a subscription window consumed; median means the middle observation.', 'The tool has not supplied usage readings for this window.'],
  ['tokens|capacity|uncached', 'Capacity is estimated from usage movement; bands span the middle half of observations, and total tokens include cached input.', 'Not enough measured usage movement to estimate capacity.'],
  ['api.equiv|api value|hosted.equiv', 'API-equivalent is the estimated list-price cost of the same tokens, not a bill or a cash saving.', 'Token counts or a matching list price are missing.'],
  ['multiple', 'Multiple divides API-equivalent value by the plan cost for the observed period; it is not cash saved.', 'A matching token price or period plan cost is missing.'],
  ['price|usd|cost|[$]|value', 'Cost uses USD; per-success cost divides priced work or period plan cost by measured successes, and lower is better.', 'A matching price or measured successful outcome is missing.'],
  ['p50|latency|speed', 'Median response latency is the middle recorded wait, not total session time; lower is better.', 'The tool has not reported response timing.'],
  ['tier|overall', 'Overall tiers use score thresholds S ≥ 80, A ≥ 65, B ≥ 50; criterion tiers compare with the best in this field.', 'Not enough sessions or observations for a tier.'],
  ['score|^$', 'Score is a 0–100 blend of rating (55%), survival (30%) and clean sessions (15%); missing parts are reweighted, with at least three sessions required.', 'Fewer than three sessions or no scorable observations.'],
  ['waste', 'Waste is the share of priced work rated 2 or less, reverted, or below 20% survival; lower is better.', 'No priced, outcome-measured sessions to estimate waste.'],
  ['correction', 'Corrections count user turns pointing out a wrong action, per user turn; lower is better.', 'No conversation signals with usable user-turn counts.'],
  ['re.prompt', 'Re-prompts repeat a request that did not land, per user turn; lower is better.', 'No conversation signals with usable user-turn counts.'],
  ['pushback', 'Pushback counts refusals and interrupted assistant turns per user turn; lower is better.', 'No conversation signals with usable user-turn counts.'],
  ['frustration', 'Frustration counts English-language frustration markers per user turn; lower is better and reporter habits affect it.', 'No conversation signals with usable user-turn counts.'],
  ['clarif', 'Clarifications count assistant turns ending with a question instead of action, per assistant turn; lower is better for this measure.', 'No conversation signals with usable assistant-turn counts.'],
  ['read', 'Unread edits are edits to files not previously read, divided by edit calls; lower is better.', 'No measured edit calls to compare.'],
  ['abandon', 'Abandonment is the share of sessions ending soon after a problem with no assistant reply; lower is better, but stopping is not proof of failure.', 'No conversation signals to assess session endings.'],
  ['error|tool err', 'Errors are recorded failure events; rates use tool calls where labelled, and lower is better.', 'No tool-call counts or failure observations available.'],
  ['rate.lim|overload|timeout|context|interr|switch', 'Recorded interruptions to work, as an event count or share of sessions where labelled; lower is better.', 'This event was not recorded by the tool.'],
  ['flag| z', 'Drift compares this week with a trailing baseline; watch needs |z| ≥ 2, alert ≥ 3, and at least five sessions this week.', 'Need enough current and baseline weeks to measure change.'],
  ['quant', 'Quantisation is the numeric precision used to serve the weights; different versions stay separate.', 'The serving tool did not identify its quantisation.'],
  ['mode', 'Serving mode separates subscriptions, metered APIs and models running locally.', 'Serving mode was not identified.'],
  ['window|scope|reset', 'A window is the period before a usage allowance resets; scope identifies the allowance being measured.', 'No reset-window readings supplied by the tool.'],
  ['month|week|hour|dur|work', 'Observed time or period coverage for this row, not a guaranteed amount of productive work.', 'No duration or period coverage recorded.'],
  ['model|family|provider|tool|plan|category|task|language|lang|effort|size', 'The identity or work group being compared; different tools, tasks, hosts and model variants can affect results.', 'This identity was not recorded.'],
];
export function metricDefinition(label: string): [string, string] {
  const match = definitions.find(([pattern]) => new RegExp(pattern, 'i').test(label));
  return match ? [match[1], match[2]] : ['Score and sample size for this labelled group; compare like tasks and tool setups.', 'No observations for this group in the selected period.'];
}
const escapeAttribute = (s: string): string => s.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
export function defineHeaders(html: string): string {
  return html.split(/(<script>[\s\S]*?<\/script>)/g).map(part => part.startsWith('<script>') ? part : part.replace(/<th(\s[^>]*|)>([\s\S]*?)<\/th>/g, (all, attrs: string, body: string) => {
    if (attrs.includes('data-definition')) return all;
    const label = body.replace(/<[^>]+>/g, '').trim();
    return `<th${attrs} data-definition="${escapeAttribute(metricDefinition(label)[0])}">${body}</th>`;
  })).join('');
}
export const READ_GUIDE = `<details class="read-guide"><summary>How to read this</summary><ul>
<li><b>Quality</b> — optional human rating, 1–5. Rate a finished session with <code>/nerfd 4 kept</code>.</li>
<li><b>Reliability</b> — share of clean sessions: no errors, rate limits, interrupts or model switches.</li>
<li><b>Steering</b> — corrections, re-prompts and pushback per user turn; lower is better.</li>
<li><b>Survival</b> — share of added code still present after an hour; measured by <code>nerfd check</code>.</li>
<li><b>Speed</b> — median response wait; lower is better, and tools report it differently.</li>
<li><b>Value</b> — USD per measured success; lower is better, with local estimates kept separate.</li>
</ul><p>Score blends rating, survival and clean sessions; missing parts are reweighted. A score without ratings is not a quality verdict. n counts sessions, not ratings. Public tiers need 10 sessions; scores need 3.</p><p>A <b>band</b> spans the middle half of observations. <b>API-equivalent</b> estimates list-price token cost, not your bill. A <b>multiple</b> divides that value by period plan cost. A <b>reporter-week</b> is one person in one week, not a unique person across weeks. An <b>assumed plan</b> applies today’s plan to older sessions without a recorded plan. <b>Friction</b> means interruptions and extra direction; a <b>wall hit</b> means a usage limit stopped work.</p><p>English-language signals are heuristics, sensitive to task, tool and reporter habits. Small samples describe this record, not all users. Select any ? for a definition or a missing value for its reason.</p></details>`;
export const READABLE_CSS = `
.answer{font-size:16px;line-height:1.65;max-width:780px;margin:14px 0 22px;color:var(--fg)}
.glance-panel{padding:26px;border:1px solid var(--line);border-radius:14px;background:var(--panel);margin:24px 0}.glance-panel h2{font-size:22px;margin:0}.glance-panel .answer{margin:12px 0 20px}.glance-panel .stats{border:0;background:var(--soft)}
.read-guide{margin:20px 0 28px;padding:14px 18px;border:1px solid var(--line);border-radius:10px;font-size:12px;color:var(--mut)}summary{cursor:pointer;color:var(--fg);font-weight:500}.read-guide ul{padding-left:18px}.read-guide li{margin:8px 0}.read-guide p{max-width:850px}
.section-nav{display:flex;gap:8px 18px;flex-wrap:wrap;padding:12px 0;border-bottom:1px solid var(--line);font-size:12px;color:var(--mut);background:var(--bg);z-index:5}.section-nav a{color:inherit;text-decoration:none}.section-nav a:hover{color:var(--fg)}
section{scroll-margin-top:84px}main>section{padding-top:56px;margin-top:12px}main>section h2{font-size:23px;letter-spacing:-.6px}.section-number{display:block;font:11px var(--mono);color:var(--mut);margin-bottom:10px}
.detail-toggle{display:block;margin:12px 0 8px;font-size:12px;padding:6px 10px}.compact-table .detail-cell{display:none}.compact-table td{padding-top:16px;padding-bottom:16px}.compact-table td:first-child{white-space:normal;min-width:130px}.compact-table .identity{flex-wrap:wrap}.compact-table .provider{display:block}.compact-table .row-group th{display:table-cell}
.metric-help{display:inline-grid;place-items:center;margin-left:5px;width:17px;height:17px;border-radius:50%;padding:0;font:11px -apple-system,BlinkMacSystemFont,sans-serif;text-transform:none;vertical-align:middle;color:var(--mut);background:var(--panel);border:1px solid var(--line)}
.metric-popover{position:fixed;inset:auto;max-width:min(320px,calc(100vw - 32px));padding:14px 16px;border:1px solid var(--line);border-radius:10px;color:var(--fg);background:var(--panel);box-shadow:0 8px 30px #0002;font:13px/1.6 -apple-system,BlinkMacSystemFont,sans-serif;z-index:20;margin:0}
.sort-header{cursor:pointer;user-select:none}.sort-header[aria-sort="ascending"]::after{content:" ↑"}.sort-header[aria-sort="descending"]::after{content:" ↓"}
.missing{color:var(--mut);text-decoration:underline dotted;text-underline-offset:3px;cursor:help}.family-card>summary{padding:16px}.family-card>summary h3{display:inline;padding:0}.family-card .detail-toggle{margin-left:14px}.rank-metrics{grid-template-columns:repeat(4,minmax(0,1fr))}.rank-detail{margin-top:12px;font-size:12px}.rank-detail .rank-metrics{margin-top:12px}.section-context{font-size:12px;color:var(--mut)}
@media(min-width:900px){.section-nav{position:sticky;top:0;backdrop-filter:blur(16px)}}
@media(max-width:600px){.glance-panel{padding:18px}.answer{font-size:15px}.compact-table th,.compact-table td{padding:10px 8px;font-size:11px}.compact-table .identity{gap:5px}.section-nav{font-size:11px}main>section{padding-top:36px}.rank-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media print{.section-nav,.detail-toggle,.metric-help,.read-guide{display:none}.compact-table .detail-cell{display:table-cell}details>*{display:block!important}}
`;
export const READABLE_JS = `
(() => {
 const definitions = ${JSON.stringify(definitions)};
 const meaning = label => { const m = definitions.find(d => new RegExp(d[0], 'i').test(label)); return m ? m.slice(1) : ['Score and sample size for this labelled group; compare like tasks and tool setups.', 'No observations for this group in this period.']; };
 const stored = key => { try { return localStorage.getItem(key) === 'detail'; } catch { return false; } };
 const pop = document.createElement('div'); pop.className = 'metric-popover'; pop.id = 'metric-popover'; pop.setAttribute('popover', 'auto'); pop.setAttribute('role','tooltip'); if(!('showPopover' in pop)) pop.hidden=true; document.body.append(pop);
 function help(el, definition) {
   el.setAttribute('aria-description', definition);
   el.addEventListener('click', () => { pop.textContent = definition; if (typeof pop.showPopover === 'function') pop.showPopover(); else pop.hidden = false; const r = el.getBoundingClientRect(); pop.style.left = Math.max(16, Math.min(r.left, innerWidth - 336)) + 'px'; pop.style.top = Math.max(16, Math.min(r.bottom + 8, innerHeight - pop.offsetHeight - 16)) + 'px'; });
 }
 function decorate() {
   document.querySelectorAll('th').forEach(th => {
     if (th.querySelector('.metric-help')) return;
     const label = th.textContent.trim(); const definition = th.dataset.definition || meaning(label)[0];
     th.dataset.label = label; th.dataset.definition = definition;
     const b = document.createElement('button'); b.type = 'button'; b.className = 'metric-help'; b.textContent = '?'; b.setAttribute('aria-label', 'Explain ' + (label || 'score bar')); help(b, definition); th.append(b);
   });
   document.querySelectorAll('dt,.rank-metrics small,.stat>span').forEach(label => {
     if(label.querySelector('.metric-help')) return;
     const text = label.textContent.trim(); const b = document.createElement('button'); b.type='button'; b.className='metric-help'; b.textContent='?'; b.setAttribute('aria-label','Explain '+text); help(b,meaning(text)[0]); label.append(b);
   });
   document.querySelectorAll('dd,.rank-metrics>div>span,.stat>b').forEach(value => {
     if(value.textContent.trim() !== '—' && value.textContent.trim() !== '–' && value.textContent.trim() !== '-') return;
     if(value.querySelector('.missing')) return;
     const label = value.previousElementSibling?.textContent || value.nextElementSibling?.textContent || '';
     const missing=document.createElement('span'); missing.textContent=value.textContent; missing.className='missing'; missing.tabIndex=0; missing.setAttribute('role','button'); missing.title=meaning(label)[1]; help(missing,meaning(label)[1]); missing.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();missing.click();}}); value.replaceChildren(missing);
   });
   document.querySelectorAll('table').forEach((table, index) => {
     const headers = [...(table.tHead?.rows[0]?.cells || [])];
     if (!headers.length) return;
     const labels = headers.map(h => (h.dataset.label || h.textContent).toLowerCase());
     const keep = new Set([0]);
     // A page can name its decision columns; otherwise identity, tier, score, cost and evidence are the decision layer.
     const explicit = table.dataset.keep ? table.dataset.keep.split(',').map(s => s.trim().toLowerCase()) : null;
     const priorities = explicit ? explicit.map(k => new RegExp('^' + k.replace(/[.*+?^{}$()|[\\]\\\\]/g, '\\\\$&') + '$')) : [/^tier$|^overall$/, /^score$/, /\\$.*success|usd.*success|tokens.*dollar/, /^n$|n sessions|evidence|reporter|this week n/, /^plan$/, /^price$|usd.*month/, /steer/, /total tokens/, /quality|reliability/];
     const limit = explicit ? Math.max(5, explicit.length) : 5;
     for (const pattern of priorities) { const i = labels.findIndex(l => pattern.test(l)); if (i >= 0 && keep.size < limit) keep.add(i); }
     for (let i = 1; keep.size < Math.min(5, headers.length); i++) keep.add(i);
     for (const row of table.rows) for (let i=0;i<row.cells.length;i++) row.cells[i].classList.toggle('detail-cell', row.cells[i].colSpan === 1 && !keep.has(i));
     if (!table.dataset.enhanced) {
       table.dataset.enhanced = 'true';
       const region = table.closest('.table-wrap,.tbl') || table;
       const key = 'nerfd:detail:' + location.pathname + ':' + (table.id || (table.closest('section')?.id || 'page') + ':' + index);
       const b = document.createElement('button'); b.type = 'button'; b.className = 'detail-toggle';
       const set = detail => { table.classList.toggle('compact-table', !detail); b.textContent = detail ? 'Show less' : 'Show detail'; b.setAttribute('aria-expanded', String(detail)); };
       set(stored(key) || Boolean(location.hash && table.closest('section')?.id === location.hash.slice(1)));
       b.addEventListener('click', () => { const detail = table.classList.contains('compact-table'); set(detail); try { localStorage.setItem(key, detail ? 'detail' : 'compact'); } catch {} });
       region.before(b);
     }
     if (table.hasAttribute('data-sortable') && !table.dataset.sorted && table.tBodies.length === 1) {
       table.dataset.sorted = 'true';
       const value = (cell) => { if (cell.dataset.sort != null) return Number(cell.dataset.sort); const t = cell.textContent.trim(); const tier = {S:4,A:3,B:2,C:1}[t.charAt(0)]; if (/^[SABC](\\s|$)/.test(t) && tier) return tier; const n = parseFloat(t.replace(/[$,%×x\\s]/g, '').replace(/^#/, '')); return Number.isFinite(n) && /^[#$]?[-+\\d.]/.test(t) ? n : t.toLowerCase(); };
       headers.forEach((th, i) => {
         th.classList.add('sort-header');
         th.addEventListener('click', (e) => {
           if (e.target.closest('.metric-help')) return;
           const dir = th.getAttribute('aria-sort') === 'descending' ? 'ascending' : 'descending';
           headers.forEach(h => h.removeAttribute('aria-sort')); th.setAttribute('aria-sort', dir);
           const body = table.tBodies[0]; const rows = [...body.rows].filter(r => r.cells.length === headers.length);
           rows.sort((a, b) => { const x = value(a.cells[i]), y = value(b.cells[i]); const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y)); return dir === 'ascending' ? c : -c; });
           body.append(...rows);
         });
       });
     }
     table.querySelectorAll('td').forEach(td => {
       const label = labels[td.cellIndex] || '';
       const walker = document.createTreeWalker(td, NodeFilter.SHOW_TEXT); const nodes = []; while(walker.nextNode()) nodes.push(walker.currentNode);
       for (const node of nodes) if (/^[–—-]$/.test(node.textContent.trim()) && !node.parentElement.closest('.missing')) { const span = document.createElement('span'); span.className = 'missing'; span.tabIndex = 0; span.setAttribute('role','button'); span.textContent = node.textContent; span.title = meaning(label)[1]; span.setAttribute('aria-label', meaning(label)[1]); help(span, meaning(label)[1]); span.addEventListener('keydown', e => { if(e.key === 'Enter' || e.key === ' ') { e.preventDefault(); span.click(); } }); node.replaceWith(span); }
     });
   });
   document.querySelectorAll('.rank-detail:not([data-saved])').forEach((detail,i) => { detail.dataset.saved='true'; const key='nerfd:detail:'+location.pathname+':model:'+i; detail.open=stored(key); detail.addEventListener('toggle',()=>{try{localStorage.setItem(key,detail.open?'detail':'compact');}catch{}}); });
   document.querySelectorAll('.family-card:not([data-disclosed])').forEach((card, i) => { const d = document.createElement('details'); d.className = card.className; d.dataset.disclosed = 'true'; d.open = i === 0 || location.hash === '#providers'; const summary = document.createElement('summary'); const heading = card.querySelector('h3'); if (heading) summary.append(heading); d.append(summary, ...card.childNodes); card.replaceWith(d); });
 }
 let pending = false;
 const observer = new MutationObserver(() => { if(pending) return; pending = true; queueMicrotask(() => { pending=false; observer.disconnect(); decorate(); observer.observe(document.querySelector('main') || document.body, {childList:true,subtree:true}); }); });
 decorate(); observer.observe(document.querySelector('main') || document.body, {childList:true,subtree:true});
 addEventListener('hashchange', () => { const section = document.getElementById(location.hash.slice(1)); section?.querySelectorAll('table.compact-table').forEach(t => { const region = t.closest('.table-wrap,.tbl') || t; region.previousElementSibling?.click(); }); section?.querySelectorAll('.family-card').forEach(d => d.open = true); });
})();
`;
