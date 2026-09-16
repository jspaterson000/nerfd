import { READ_GUIDE, READABLE_CSS, READABLE_JS, defineHeaders } from '../assets/presentation.ts';
import { esc, FAVICON, IDENTITY_JS, SHARED_CSS, socialMeta } from './ui.ts';

// One model, one page: where it ranks, on what work, and how it has moved
// since it was first seen. Everything is fetched from /v1/model, which runs
// the same aggregator as the tier board, so the two never disagree.
//
// /model with no id is the index: every model on record, linked.

/** `/model/<id>` or `/model?id=`. Bounded and trimmed; the query layer does the rest. */
export function modelIdFromPath(url: URL): string {
  const q = url.searchParams.get('id');
  let id = q ?? (url.pathname.startsWith('/model/') ? url.pathname.slice('/model/'.length) : '');
  try { id = decodeURIComponent(id); } catch { /* keep as-is */ }
  return id.trim().slice(0, 120);
}

const MODEL_CSS = `
body{padding:0 28px 48px;max-width:1180px;margin:auto;font-size:13px}
header{display:flex;flex-wrap:wrap;gap:12px 24px;align-items:center;min-height:72px;border-bottom:1px solid var(--line)}
header nav{display:flex;gap:20px;margin-left:auto;color:var(--mut);font-size:12px}
.crumbs{font-size:12px;color:var(--mut);margin:22px 0 0}.crumbs a:hover{color:var(--fg)}
.model-hero{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:20px 40px;align-items:start;margin:14px 0 8px;padding:26px;border:1px solid var(--line);border-radius:14px;background:var(--panel)}
.model-hero h1{display:flex;align-items:center;flex-wrap:wrap;gap:12px;overflow-wrap:anywhere;min-width:0;font-size:28px;letter-spacing:-.8px;line-height:1.15;margin:0 0 8px;font-weight:600}.model-hero h1 .logo{width:40px;height:40px;border-radius:10px}.model-hero h1 .logo img{width:26px;height:26px}
.model-hero .facts{display:flex;flex-wrap:wrap;gap:6px 8px;margin:10px 0 0}.model-hero .facts .chip{font-size:11px;padding:3px 8px}
.model-hero .standing{text-align:right;min-width:190px}.standing .big{display:flex;align-items:center;justify-content:flex-end;gap:10px}.standing .tier{min-width:44px;line-height:42px;font-size:22px;border-radius:10px;margin:0}.standing .score{font:500 38px/1 var(--mono);letter-spacing:-1.5px}.standing p{margin:8px 0 0;font-size:12px;color:var(--mut)}
.model-controls{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;margin:14px 0 0;font-size:12px;color:var(--mut)}.model-controls select{font-size:12px;min-height:30px}
.criteria-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:8px}.criterion{padding:16px 18px;border:1px solid var(--line);border-radius:12px;background:var(--panel)}.criterion h3{display:flex;align-items:center;justify-content:space-between;margin:0 0 10px;font-size:12px;font-weight:600;text-transform:capitalize}.criterion .val{font:500 24px/1.1 var(--mono);letter-spacing:-.8px}.criterion p{margin:8px 0 0;font-size:11px;color:var(--mut);line-height:1.6}.criterion .lower{font-size:10px;font-weight:400;color:var(--mut);margin-left:6px;text-transform:none}
.work-bar{display:inline-block;width:70px;height:5px;vertical-align:middle;margin-right:8px;background:var(--soft);border-radius:3px;overflow:hidden}.work-bar i{display:block;height:100%;background:var(--fg);opacity:.75}
.rank{font-family:var(--mono);font-size:12px}.rank small{color:var(--mut);font-size:11px}
.timeline{margin:8px 0 0;padding:18px 18px 8px;border:1px solid var(--line);border-radius:12px;background:var(--panel)}.timeline svg{display:block;width:100%;height:auto;font:11px var(--mono);fill:var(--mut)}.timeline figcaption{display:flex;flex-wrap:wrap;gap:8px 22px;font-size:11px;color:var(--mut);padding:10px 0 6px}.timeline .key{display:inline-flex;align-items:center;gap:6px}.key i{display:inline-block;width:18px;height:0;border-top:2px solid var(--fg)}.key i.field{border-top-style:dashed;border-color:var(--mut)}.key b{display:inline-block;width:9px;height:9px;border-radius:50%}.key b.watch{background:var(--warn)}.key b.alert{background:var(--bad)}.key s{display:inline-block;width:12px;height:12px;background:var(--soft);border:1px solid var(--line);text-decoration:none}
.shift{display:grid;grid-template-columns:auto minmax(0,1fr);gap:16px 22px;align-items:center;margin:16px 0 0;padding:18px 20px;border:1px solid var(--line);border-radius:12px;background:var(--panel)}.shift .verdict{padding:6px 12px;border:1px solid var(--line);border-radius:8px;font:600 12px var(--mono);text-transform:uppercase;letter-spacing:.06em;color:var(--mut);background:var(--soft)}.shift .verdict.worse{color:var(--bad);border-color:var(--bad)}.shift .verdict.better{color:var(--ok);border-color:var(--ok)}.shift .verdict.mixed{color:var(--warn);border-color:var(--warn)}.shift p{margin:0;font-size:13px;line-height:1.6}.shift small{display:block;color:var(--mut);font-size:11px;margin-top:4px}
.flag-alert{color:var(--bad);font-weight:600}.flag-watch{color:var(--warn);font-weight:600}.flag-none{color:var(--mut)}.moves{font-size:11px;color:var(--mut);white-space:normal;max-width:280px}.moves .worse{color:var(--bad)}.moves .better{color:var(--ok)}
.breakdown{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px;margin-top:8px}.breakdown h3{font-size:12px;font-weight:600;margin:0 0 8px;text-transform:capitalize}
h2{font-size:18px;font-weight:600;letter-spacing:-.4px;margin:0 0 6px}main{min-width:0;overflow-wrap:anywhere}.sub{font-size:13px;margin:0 0 14px;max-width:760px}
.index-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px;list-style:none;padding:0;margin:16px 0}.index-list li{padding:12px 14px;border:1px solid var(--line);border-radius:10px;background:var(--panel)}.index-list li a{display:flex;align-items:center;justify-content:space-between;gap:10px}.index-list li a:hover{text-decoration:none;background:var(--hover)}.index-list .n{font-size:11px;color:var(--mut)}
.mut a{text-decoration:underline;text-underline-offset:3px}
footer{margin-top:32px;padding-top:18px;border-top:1px solid var(--line);color:var(--mut);font-size:11px;max-width:1100px}footer p{margin:6px 0}
.sort-header{cursor:pointer;user-select:none}.sort-header[aria-sort="ascending"]::after{content:" ↑"}.sort-header[aria-sort="descending"]::after{content:" ↓"}
@media(max-width:800px){.model-hero{grid-template-columns:1fr}.model-hero .standing{text-align:left}.standing .big{justify-content:flex-start}.criteria-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:600px){body{padding:0 16px 32px}.model-hero{padding:18px}.model-hero h1{font-size:22px}.criteria-grid{grid-template-columns:1fr}}
`;

const MODEL_JS = `
${IDENTITY_JS}
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const fmt = {
  pct: (v) => finite(v) ? Math.round(v * 100) + '%' : '–',
  num: (v, d = 2) => finite(v) ? Number(v).toFixed(d) : '–',
  ms: (v) => finite(v) ? (v < 1000 ? Math.round(v) + ' ms' : (v / 1000).toFixed(1) + ' s') : '–',
  usd: (v) => finite(v) ? (v < 10 ? '$' + v.toFixed(2) : '$' + Math.round(v)) : '–',
  z: (v) => finite(v) ? (v > 0 ? '+' : '') + v.toFixed(1) : '–',
  tier: (t) => '<span class="tier ' + (!t || t === '-' ? 'dash' : t) + '">' + (t || '–') + '</span>',
  week: (w) => String(w || '').replace(/^\\d{4}-/, ''),
};
const WEEKS = (() => { const v = Number(new URLSearchParams(location.search).get('weeks')); return [8, 13, 26, 52].includes(v) ? v : 26; })();
const MODEL = __MODEL_ID__;
const CRITERIA = { quality: 'Mean rating from the people who did the work, 1–5.', reliability: 'Share of sessions with no errors, rate limits, interrupts or model switches.', steering: 'Corrections, re-prompts and pushback per user turn.', survival: 'Share of added lines still present an hour later.', speed: 'Median response latency.', value: 'API-equivalent cost per successful session.' };
const METRIC_NAMES = { rating: 'ratings', clean: 'clean sessions', steering: 'steering', survival: 'code survival', latency: 'latency' };

// ISO week from a date, and an ordinal that keeps gaps visible on the chart.
function isoWeek(date) {
  const d = new Date(date); if (Number.isNaN(d.getTime())) return null;
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1)); const week = Math.ceil(((t - y0) / 86400000 + 1) / 7);
  return t.getUTCFullYear() + '-W' + String(week).padStart(2, '0');
}
function ordinal(week) { const m = /^(\\d{4})-W(\\d{2})$/.exec(week || ''); return m ? Number(m[1]) * 53 + Number(m[2]) : null; }
function ordinalDate(week) { const m = /^(\\d{4})-W(\\d{2})$/.exec(week || ''); if (!m) return ''; const jan4 = new Date(Date.UTC(Number(m[1]), 0, 4)); const day = jan4.getUTCDay() || 7; const monday = new Date(jan4.getTime() - (day - 1) * 86400000 + (Number(m[2]) - 1) * 7 * 86400000); return monday.toISOString().slice(0, 10); }

function chart(v) {
  const weeks = v.weekly; if (!weeks.length) return '<p class="empty">No weekly history yet.</p>';
  const releaseWeek = v.identity.released ? isoWeek(v.identity.released.length === 7 ? v.identity.released + '-01' : v.identity.released) : null;
  const ords = weeks.map(w => ordinal(w.week)).filter(finite);
  let lo = Math.min(...ords), hi = Math.max(...ords);
  const relOrd = releaseWeek ? ordinal(releaseWeek) : null;
  if (finite(relOrd) && relOrd < lo && lo - relOrd <= 12) lo = relOrd;
  if (hi === lo) { lo -= 1; hi += 1; }
  const W = 720, H = 250, L = 44, R = 16, T = 18, B = 60; const plotW = W - L - R, plotH = H - T - B;
  const x = (o) => L + (o - lo) / (hi - lo) * plotW; const y = (s) => T + (100 - s) / 100 * plotH;
  const maxN = Math.max(1, ...weeks.map(w => w.n));
  const line = (pick) => { let d = '', pen = false; for (const w of weeks) { const s = pick(w); const o = ordinal(w.week); if (!finite(s) || !finite(o)) { pen = false; continue; } d += (pen ? 'L' : 'M') + x(o).toFixed(1) + ' ' + y(s).toFixed(1); pen = true; } return d; };
  const grid = [0, 50, 100].map(s => '<path d="M' + L + ' ' + y(s) + 'H' + (W - R) + '" stroke="var(--line)"/><text x="' + (L - 8) + '" y="' + (y(s) + 4) + '" text-anchor="end">' + s + '</text>').join('');
  const bars = weeks.map(w => { const o = ordinal(w.week); if (!finite(o)) return ''; const h = Math.max(2, w.n / maxN * 26); return '<rect x="' + (x(o) - 4) + '" y="' + (H - 28 - h) + '" width="8" height="' + h + '" rx="1.5" fill="var(--mut)" opacity=".35"><title>' + esc(w.week) + ': n=' + w.n + '</title></rect>'; }).join('');
  const labels = weeks.filter((w, i) => i === 0 || i === weeks.length - 1 || weeks.length <= 10 || i % Math.ceil(weeks.length / 8) === 0).map(w => { const o = ordinal(w.week); return finite(o) ? '<text x="' + x(o) + '" y="' + (H - 8) + '" text-anchor="middle">' + esc(fmt.week(w.week)) + '</text>' : ''; }).join('');
  const dots = weeks.map(w => { const o = ordinal(w.week); if (!finite(o) || !finite(w.score)) return ''; const flag = w.flag; const r = flag === 'alert' ? 5.5 : flag === 'watch' ? 5 : 3; const fill = flag === 'alert' ? 'var(--bad)' : flag === 'watch' ? 'var(--warn)' : 'var(--fg)'; return '<circle cx="' + x(o) + '" cy="' + y(w.score) + '" r="' + r + '" fill="' + fill + '" stroke="var(--panel)" stroke-width="1.5"><title>' + esc(w.week) + ': score ' + w.score + ', n=' + w.n + (flag !== 'none' ? ', ' + flag + ': ' + w.moved.map(m => METRIC_NAMES[m.metric] + ' ' + m.direction).join(', ') : '') + '</title></circle>'; }).join('');
  const release = finite(relOrd) && relOrd >= lo && relOrd <= hi ? '<path d="M' + x(relOrd) + ' ' + T + 'V' + (H - 28) + '" stroke="var(--mut)" stroke-dasharray="2 4"/><text x="' + (x(relOrd) + 5) + '" y="' + (T + 10) + '">released</text>' : '';
  const releaseNote = releaseWeek ? (finite(relOrd) && relOrd >= lo ? '' : 'Released ' + esc(v.identity.released) + ', ' + Math.max(0, Math.round((ords[0] - relOrd))) + ' weeks before the first session on record.') : 'No release date on file for this id.';
  return '<figure class="timeline"><svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Weekly composite score for ' + esc(v.model) + ' against the whole field, with session counts and change flags">' + grid + bars + '<path d="' + line(w => w.field_score) + '" fill="none" stroke="var(--mut)" stroke-width="1.5" stroke-dasharray="5 4"/><path d="' + line(w => w.score) + '" fill="none" stroke="var(--fg)" stroke-width="2"/>' + release + dots + labels + '</svg><figcaption><span class="key"><i></i> this model, weekly score</span><span class="key"><i class="field"></i> every model that week</span><span class="key"><s></s> sessions (n)</span><span class="key"><b class="watch"></b> watch</span><span class="key"><b class="alert"></b> alert</span>' + (releaseNote ? '<span>' + releaseNote + '</span>' : '') + '</figcaption></figure>';
}

function moves(list) { return list.length ? list.map(m => '<span class="' + m.direction + '">' + METRIC_NAMES[m.metric] + ' ' + (m.direction === 'worse' ? 'worse' : 'better') + ' (z ' + fmt.z(m.z) + ')</span>').join(', ') : '<span class="mut">no measurable move</span>'; }

function shiftCard(v) {
  const s = v.shift; const range = (ws) => ws.length ? (ws.length === 1 ? fmt.week(ws[0]) : fmt.week(ws[0]) + '–' + fmt.week(ws[ws.length - 1])) : '–';
  const verdictText = { worse: 'Worse than when it arrived', better: 'Better than when it arrived', mixed: 'Moved both ways', steady: 'No measurable change', insufficient: 'Not enough history' }[s.verdict];
  const body = s.verdict === 'insufficient'
    ? 'Change detection needs at least two weeks on record and five sessions on each side. ' + (v.weeks_seen < 2 ? 'This model has ' + v.weeks_seen + ' week on record.' : 'Its earliest period (' + range(s.from) + ') has ' + s.n_from + ' and its latest (' + range(s.to) + ') has ' + s.n_to + '.')
    : 'Its first weeks on record (' + range(s.from) + ', n=' + s.n_from + ', score ' + (s.score_from ?? '–') + ') against its latest (' + range(s.to) + ', n=' + s.n_to + ', score ' + (s.score_to ?? '–') + '): ' + moves(s.moves) + '.';
  return '<div class="shift"><span class="verdict ' + s.verdict + '">' + verdictText + '</span><div><p>' + body + '</p><small>Change detection, not a verdict: effort level, tool version and the mix of work all move these numbers. |z| ≥ 2 counts as a move.</small></div></div>';
}

function answerFor(v) {
  const o = v.overall; const rated = o.group.n_rated;
  const rank = finite(o.rank) ? 'ranks #' + o.rank + ' of ' + o.of + ' models with ' + v.min_n + '+ sessions' : (v.n < v.min_n ? 'has ' + v.n + ' sessions, below the ' + v.min_n + ' needed to rank' : 'is not yet scored');
  const score = finite(o.score) ? ' (score ' + o.score + '/100' + (rated < 3 ? ', from clean sessions and code survival only; no ratings yet' : ', ' + rated + ' rated') + ')' : '';
  const ranked = v.categories.filter(c => c.eligible && finite(c.score));
  const best = ranked[0]; const worst = ranked.length > 1 ? ranked[ranked.length - 1] : null;
  const work = best ? ' Strongest at ' + workName(best.category) + ' (' + best.tier + ', #' + (best.rank ?? '–') + ' of ' + best.of + ')' + (worst && worst.category !== best.category ? ', weakest at ' + workName(worst.category) + ' (' + worst.tier + ')' : '') + '.' : (v.categories.length ? ' No kind of work has reached ' + v.min_n + ' sessions yet, so it is not ranked per task.' : '');
  const s = v.shift; const change = s.verdict === 'insufficient' ? ' Too little history to say whether it has changed.' : s.verdict === 'steady' ? ' No measurable change since it was first seen in ' + v.first_week + '.' : ' Since ' + v.first_week + ' it has got ' + (s.verdict === 'mixed' ? 'better on some measures and worse on others' : s.verdict) + (v.changes.length ? '; the sharpest week was ' + v.changes.reduce((a, b) => (a.flag === 'alert' && b.flag !== 'alert') ? a : b).week + '.' : '.');
  return v.model + ' ' + rank + score + ' over the last ' + v.weeks + ' weeks (n=' + v.n + ').' + work + change;
}

function render(v) {
  document.title = v.model + ' · nerfd';
  const id = v.identity;
  $('#hero-name').innerHTML = identity(v.model, id.providers.length === 1 ? id.providers[0] : null);
  const facts = [];
  if (id.display) facts.push(esc(id.display) + (id.version ? ' ' + esc(id.version) : ''));
  if (id.vendor) facts.push(esc(id.vendor));
  if (id.open_weights) facts.push('open weights');
  for (const m of id.serving_modes) facts.push(esc(m));
  for (const t of id.tools) facts.push('via ' + esc(t));
  $('#hero-facts').innerHTML = facts.map(f => '<span class="chip">' + f + '</span>').join('');
  $('#hero-when').textContent = (id.released ? 'Released ' + id.released + (id.released_source === 'family-table' ? ' (month)' : '') + ' · ' : '') + 'first seen ' + (v.first_week || '–') + ' · ' + v.weeks_seen + ' week' + (v.weeks_seen === 1 ? '' : 's') + ' on record · ' + v.n + ' sessions';
  $('#hero-tier').innerHTML = fmt.tier(v.overall.tier) + '<span class="score">' + (finite(v.overall.score) ? v.overall.score : '–') + '</span>';
  $('#hero-rank').textContent = finite(v.overall.rank) ? 'Rank ' + v.overall.rank + ' of ' + v.overall.of + ' in the field, last ' + v.weeks + ' weeks' : (v.n < v.min_n ? 'Needs ' + v.min_n + ' sessions to rank; has ' + v.n : 'Unscored in this window');
  $('#model-answer').textContent = answerFor(v);

  // 01 Where it ranks
  $('#criteria').innerHTML = v.overall.criteria.map(c => '<div class="criterion"><h3>' + c.criterion + (c.lower_better ? '<span class="lower">lower is better</span>' : '') + fmt.tier(c.tier) + '</h3><div class="val">' + esc(c.display) + '</div><p>' + (finite(c.rank) ? '#' + c.rank + ' of ' + c.of + (c.best && c.best.model !== v.model ? ' · best: ' + esc(c.best.model) + ' ' + esc(c.best.display) : c.best ? ' · best in field' : '') : (c.value == null ? 'Not measured yet. ' : 'Below the session minimum. ')) + '</p><p>' + CRITERIA[c.criterion] + '</p></div>').join('');

  // 02 Against what work
  const cats = v.categories; const maxScore = Math.max(1, ...cats.map(c => finite(c.score) ? c.score : 0));
  $('#work tbody').innerHTML = cats.map(c => '<tr' + (c.eligible ? '' : ' class="thin"') + '><td><a href="/board?category=' + encodeURIComponent(c.category) + '#tiers-section">' + esc(workName(c.category)) + '</a><small class="cost-note">' + esc(c.category) + '</small></td>' +
    '<td>' + fmt.tier(c.tier) + '</td>' +
    '<td class="n" data-sort="' + (finite(c.score) ? c.score : -1) + '"><span class="work-bar"><i style="width:' + (finite(c.score) ? c.score / maxScore * 100 : 0) + '%"></i></span>' + (finite(c.score) ? c.score : '–') + '</td>' +
    '<td class="n rank" data-sort="' + (finite(c.rank) ? c.rank : 999) + '">' + (finite(c.rank) ? '#' + c.rank + ' <small>of ' + c.of + '</small>' : '<small>needs ' + v.min_n + '</small>') + '</td>' +
    '<td class="n">' + c.n + ' <small class="mut">/ ' + c.n_field + '</small></td>' +
    '<td class="n">' + fmt.pct(c.success_rate) + '</td>' +
    '<td class="n">' + fmt.num(c.rating_mean) + (c.n_rated ? ' <small class="mut">(' + c.n_rated + ')</small>' : '') + '</td>' +
    '<td class="n">' + fmt.pct(c.friction_free) + '</td>' +
    '<td class="n">' + fmt.pct(c.steering) + '</td>' +
    '<td class="n">' + fmt.usd(c.cost_per_success) + '</td>' +
    '<td>' + (c.best ? (c.best.model === v.model ? '<span class="mut">this model</span>' : modelLink(c.best.model) + ' <span class="mut">' + (c.best.score ?? '') + '</span>') : '<span class="mut">nobody ranked yet</span>') + '</td></tr>').join('') || '<tr><td colspan="11" class="empty">No sessions on any kind of work in this window.</td></tr>';
  const ranked = cats.filter(c => c.eligible); const thin = cats.length - ranked.length;
  $('#work-answer').textContent = ranked.length ? 'Ranked on ' + ranked.length + ' kind' + (ranked.length === 1 ? '' : 's') + ' of work' + (thin ? ', with ' + thin + ' more below the ' + v.min_n + '-session minimum' : '') + '. ' + (ranked[0] ? 'Best relative standing: ' + workName(ranked[0].category) + ', ' + (ranked[0].tier) + ' tier, #' + (ranked[0].rank ?? '–') + ' of ' + ranked[0].of + '.' : '') + ' Categories are inferred from the conversation and can be corrected with nerfd rate.' : (cats.length ? 'Sessions exist on ' + cats.length + ' kind' + (cats.length === 1 ? '' : 's') + ' of work, but none has reached the ' + v.min_n + ' sessions a per-task rank needs.' : 'No sessions in this window.');

  // 03 Over time
  $('#timeline').innerHTML = chart(v) + shiftCard(v);
  $('#week-table tbody').innerHTML = v.weekly.slice().reverse().map(w => '<tr><td class="mono">' + esc(w.week) + '<small class="cost-note">' + ordinalDate(w.week) + '</small></td><td class="n">' + w.n + '</td><td class="n">' + (finite(w.score) ? w.score : '–') + '</td><td class="n">' + (finite(w.field_score) ? w.field_score : '–') + '</td><td class="n">' + fmt.num(w.rating_mean) + (w.n_rated ? ' <small class="mut">(' + w.n_rated + ')</small>' : '') + '</td><td class="n">' + fmt.pct(w.friction_free) + '</td><td class="n">' + fmt.pct(w.steering) + '</td><td class="n">' + fmt.pct(w.survival_mean) + '</td><td class="n">' + fmt.ms(w.latency_p50_ms) + '</td><td class="n">' + fmt.pct(w.error_rate) + '</td><td class="flag-' + w.flag + '">' + w.flag + '</td><td class="moves">' + (w.moved.length ? moves(w.moved) : '<span class="mut">–</span>') + '</td><td class="mut">' + esc(w.tools.join(', ')) + (w.efforts.filter(e => e !== '-').length ? ' · ' + esc(w.efforts.filter(e => e !== '-').join(', ')) : '') + '</td></tr>').join('') || '<tr><td colspan="13" class="empty">No weeks on record.</td></tr>';
  const flagged = v.changes;
  $('#time-answer').textContent = (flagged.length ? flagged.length + ' flagged week' + (flagged.length === 1 ? '' : 's') + ' against the trailing baseline: ' + flagged.map(w => w.week + ' (' + w.flag + ': ' + w.moved.map(m => METRIC_NAMES[m.metric] + ' ' + m.direction).join(', ') + ')').join('; ') + '.' : 'No week moved far enough from its trailing four weeks to flag' + (v.weekly.some(w => w.n >= 5) ? '.' : '; a flag also needs five sessions in the week.')) + ' The dashed line is every model that week, on the same formula, so a dip shared by the field is not this model\\'s.';

  // 04 Steering
  const g = v.overall.group;
  $('#friction tbody').innerHTML = '<tr><td class="n">' + g.n_signals + '</td>' + [g.correction_rate, g.reprompt_rate, g.frustration_rate, g.pushback_rate, g.clarification_rate, g.edit_without_read_rate, g.abandoned_rate, g.tool_call_error_rate].map(x => '<td class="n">' + fmt.pct(x) + '</td>').join('') + '<td class="n">' + fmt.pct(g.rate_limit_rate) + '</td><td class="n">' + fmt.pct(g.overloaded_rate) + '</td><td class="n">' + fmt.pct(g.interrupt_rate) + '</td><td class="n">' + fmt.pct(g.switch_rate) + '</td></tr>';
  const st = v.overall.criteria.find(c => c.criterion === 'steering');
  $('#friction-answer').textContent = g.n_signals ? 'Across ' + g.n_signals + ' sessions with conversation signals, people corrected, re-prompted or pushed back on ' + fmt.pct(st.value) + ' of their turns' + (finite(st.rank) ? ', #' + st.rank + ' of ' + st.of + ' in the field (lower is better)' : '') + '. Errors interrupted ' + fmt.pct(g.error_rate) + ' of sessions; a subscription wall stopped ' + fmt.pct(g.rate_limit_rate) + '.' : 'No conversation signals for this model yet. Supported tools compute them locally when a session ends.';

  // 05 Hosts
  const hosts = v.hosts;
  const hostRows = hosts.filter(h => h.n >= 3);
  $('#hosts tbody').innerHTML = hostRows.map(h => { const k = h.key; const me = k.model === v.model; return '<tr' + (me ? ' class="local-row"' : '') + '><td>' + (me ? identity(k.model) : modelLink(k.model)) + '</td><td>' + identity(k.provider === '-' ? 'unknown' : k.provider) + '</td><td><span class="chip mono">' + esc(k.quant) + '</span></td><td class="mode">' + esc(k.serving_mode) + '</td><td class="n">' + h.n + '</td><td class="n">' + (finite(h.score) ? h.score : '–') + '</td><td class="n">' + fmt.num(h.rating_mean) + '</td><td class="n">' + fmt.pct(h.friction_free) + '</td><td class="n tool-error">' + fmt.pct(h.tool_call_error_rate) + '</td><td class="n">' + fmt.ms(h.latency_p50_ms) + '</td><td class="n">' + fmt.usd(h.cost_per_success) + '</td></tr>'; }).join('') || '<tr><td colspan="11" class="empty">' + (id.family ? 'Only one host has three or more sessions on these weights in this window.' : 'This id could not be tied to a weights family, so hosts cannot be compared.') + '</td></tr>';
  $('#hosts-answer').textContent = hostRows.length > 1 ? hostRows.length + ' serving variants of ' + (id.display || id.family) + ' are on record. Compare the same quantisation and kind of work before attributing a difference to the host.' : 'A single host is evidence of use, not a head-to-head comparison.';

  // 06 Where it ran
  const small = (title, groups, key, label) => '<div><h3>' + title + '</h3><div class="table-wrap"><table data-keep="' + label + ',n,score"><thead><tr><th>' + label + '</th><th class="n">n</th><th class="n">score</th><th class="n">success</th><th class="n">steering</th><th class="n">$ / success</th></tr></thead><tbody>' + groups.sort((a, b) => b.n - a.n).map(g => '<tr><td>' + (key === 'tool' ? identity(g.key[key]) : esc(g.key[key] === '-' ? 'unknown' : g.key[key])) + '</td><td class="n">' + g.n + '</td><td class="n">' + (finite(g.score) ? g.score : '–') + '</td><td class="n">' + fmt.pct(g.success_rate) + '</td><td class="n">' + fmt.pct(steeringOf(g)) + '</td><td class="n">' + fmt.usd(g.cost_per_success) + '</td></tr>').join('') + '</tbody></table></div></div>';
  const b = v.breakdown;
  $('#breakdown').innerHTML = small('By tool', b.tool, 'tool', 'tool') + small('By plan', b.plan, 'plan_id', 'plan') + small('By language', b.lang, 'lang', 'language') + small('By task size', b.size, 'size', 'size') + small('By reasoning effort', b.effort, 'effort', 'effort');
  $('#ran-answer').textContent = 'Ran through ' + id.tools.join(', ') + (id.plans.length ? ' on ' + id.plans.map(p => p.plan_id + ' (' + p.n + ')').join(', ') : '') + '. Same weights can behave differently by tool and effort level; compare within a row before comparing across models.';
}
function steeringOf(g) { if (!g || !g.n_signals) return null; const parts = [g.correction_rate, g.reprompt_rate, g.pushback_rate].filter(finite); return parts.length ? parts.reduce((a, b) => a + b, 0) : null; }

async function renderIndex() {
  const [m, s] = await Promise.all([fetch('/v1/meta').then(r => r.json()), fetch('/v1/stats?by=model&weeks=' + WEEKS).then(r => r.json())]);
  const byModel = new Map(s.groups.map(g => [g.key.model, g]));
  $('#model-answer').textContent = m.models.length + ' models are on record. Each page shows where the model ranks, on what kind of work, and how it has moved week by week since it was first seen.';
  $('#index').innerHTML = m.models.slice().sort((a, b) => ((byModel.get(b)?.n) || 0) - ((byModel.get(a)?.n) || 0)).map(id => { const g = byModel.get(id); return '<li><a href="/model/' + encodeURIComponent(id) + '">' + identity(id) + '<span class="n">' + (g ? g.n + ' sessions' + (finite(g.score) ? ' · ' + g.score : '') : 'none in ' + WEEKS + ' w') + '</span></a></li>'; }).join('');
}

async function load() {
  if (!MODEL) { document.body.classList.add('index'); await renderIndex(); return; }
  let res, data = null;
  try { res = await fetch('/v1/model?id=' + encodeURIComponent(MODEL) + '&weeks=' + WEEKS); data = await res.json(); } catch (e) { $('#model-answer').textContent = 'Unable to load this model. ' + e.message; return; }
  if (!res.ok || !data || data.error) {
    $('#model-answer').textContent = 'No sessions for ' + MODEL + ' in the last ' + WEEKS + ' weeks. Widen the window above, or go back to the board.';
    document.body.classList.add('missing');
    return;
  }
  render(data);
}
$('#weeks').value = String(WEEKS);
$('#weeks').addEventListener('change', () => { const u = new URL(location.href); u.searchParams.set('weeks', $('#weeks').value); location.href = u.toString(); });
load();
`;

export function modelPage(title: string, readOnly: boolean, origin: string, id: string): string {
  const index = !id;
  const js = MODEL_JS.replace('__MODEL_ID__', () => JSON.stringify(id));
  return defineHeaders(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${index ? 'Models' : esc(id)} · ${esc(title)}</title>
<meta name="description" content="${index ? 'Every AI model on the nerfd record, with where each ranks, on what work, and how it has changed over time.' : esc(id) + ' on real work: rank, strengths by kind of work, and week-by-week change since release.'}">
${readOnly ? '' : socialMeta(origin, index ? '/model' : '/model/' + encodeURIComponent(id), index ? 'Models on record · nerfd.ai' : id + ' on real work · nerfd.ai', index ? 'Every AI model on the record, with where each ranks, on what work, and how it has changed over time.' : id + ': rank in the field, strengths by kind of work, and week-by-week change since release.')}
${FAVICON}
<style>${SHARED_CSS}${READABLE_CSS}${MODEL_CSS}
body.index .model-only,body.missing .model-only{display:none}body:not(.index) .index-only{display:none}
</style>
</head>
<body>
<header>
  <a class="brand" href="/"><span class="app-icon" aria-hidden="true">n</span><span>nerfd<em>.ai</em></span></a>
  <nav aria-label="Main navigation"><a href="/board">Board</a><a href="/model">Models</a>${readOnly ? '' : `<a href="${esc(origin)}/#install">Install</a>`}<a href="/privacy">Privacy</a></nav>
</header>
<main>
<p class="crumbs"><a href="/board">Board</a> › <a href="/model">Models</a>${index ? '' : ` › ${esc(id)}`}</p>
${index ? `<div class="model-hero"><div><h1>Models on record</h1><p class="answer" id="model-answer" aria-live="polite">Loading the models on record.</p></div></div><ul class="index-list index-only" id="index"></ul>` : `
<div class="model-hero">
  <div>
    <h1 id="hero-name">${esc(id)}</h1>
    <p class="mut" id="hero-when">Loading…</p>
    <div class="facts" id="hero-facts"></div>
  </div>
  <div class="standing model-only"><div class="big" id="hero-tier"></div><p id="hero-rank"></p></div>
</div>
<p class="answer" id="model-answer" aria-live="polite">Loading this model’s record.</p>`}
<div class="model-controls"><label>Window <select id="weeks"><option value="8">8 weeks</option><option value="13">13 weeks</option><option value="26" selected>26 weeks</option><option value="52">52 weeks</option></select></label><span>Steered sessions only; automated runs are excluded from rankings.</span></div>
${READ_GUIDE}

<div class="model-only">
<nav class="section-nav" aria-label="Sections"><a href="#ranks">01 Where it ranks</a><a href="#work-section">02 Against what work</a><a href="#time">03 Over time</a><a href="#friction">04 Steering</a><a href="#hosts-section">05 Hosts</a><a href="#ran">06 Where it ran</a></nav>

<section id="ranks"><span class="section-number">01</span><h2>Where it ranks</h2>
<p class="sub">Each criterion is banded relative to the best model in the field with ${readOnly ? 'three' : 'ten'} or more sessions in the window. Rank counts only models that have a value for that criterion.</p>
<div class="criteria-grid" id="criteria"></div>
</section>

<section id="work-section"><span class="section-number">02</span><h2>Against what work</h2>
<p class="answer" id="work-answer" aria-live="polite">Loading.</p>
<p class="sub">The same tiering, run inside each kind of work: a model can be S at debugging and C at UI. Click a heading to sort; click a kind of work to filter the board to it.</p>
<div class="table-wrap" tabindex="0" role="region" aria-label="Standing by kind of work"><table id="work" data-sortable data-keep="work,tier,score,rank,n"><thead><tr><th>work</th><th>tier</th><th class="n">score</th><th class="n">rank</th><th class="n">n</th><th class="n">success</th><th class="n">quality</th><th class="n">reliability</th><th class="n">steering</th><th class="n">$ / success</th><th>best in this work</th></tr></thead><tbody></tbody></table></div>
<p class="metric-note mut">n is this model’s sessions on that work / everyone’s. Rank is among models with enough sessions on that work; “needs 10” means this model has too few there to place.</p>
</section>

<section id="time"><span class="section-number">03</span><h2>Over time</h2>
<p class="answer" id="time-answer" aria-live="polite">Loading.</p>
<p class="sub">Weekly composite score since the model was first seen, with the field beside it and the release date where one is on file. Each week is tested against its trailing four weeks: watch at |z| ≥ 2, alert at ≥ 3, five sessions minimum.</p>
<div id="timeline"></div>
<div class="table-wrap" tabindex="0" role="region" aria-label="Week by week"><table id="week-table" data-sortable data-keep="week,n,score,flag,moved"><thead><tr><th>week</th><th class="n">n</th><th class="n">score</th><th class="n">field score</th><th class="n">quality</th><th class="n">reliability</th><th class="n">steering</th><th class="n">survival</th><th class="n">p50 latency</th><th class="n">errors</th><th>flag</th><th>moved</th><th>tools · effort</th></tr></thead><tbody></tbody></table></div>
<p class="metric-note mut">Newest week first. A move is a metric that shifted |z| ≥ 2 from the trailing baseline; a flag needs five sessions that week. Tool and effort are listed because a harness change looks exactly like a weights change from here.</p>
</section>

<section id="friction"><span class="section-number">04</span><h2>How hard people had to push</h2>
<p class="answer" id="friction-answer" aria-live="polite">Loading.</p>
<div class="table-wrap" tabindex="0" role="region" aria-label="Friction and interruptions"><table data-keep="n signals,corrections,re-prompts,pushback,errors"><thead><tr><th class="n">n signals</th><th class="n">corrections</th><th class="n">re-prompts</th><th class="n">frustration</th><th class="n">pushback</th><th class="n">clarifications</th><th class="n">edits without read</th><th class="n">abandoned</th><th class="n tool-error">tool-call error</th><th class="n">rate-limited</th><th class="n">overloaded</th><th class="n">interrupted</th><th class="n">switched away</th></tr></thead><tbody></tbody></table></div>
<p class="metric-note mut">Lower is better throughout. Signals are counts computed on the reporter’s machine from the conversation; no text is sent. Rate-limited, overloaded, interrupted and switched are shares of sessions.</p>
</section>

<section id="hosts-section"><span class="section-number">05</span><h2>Same weights, different host</h2>
<p class="answer" id="hosts-answer" aria-live="polite">Loading.</p>
<div class="table-wrap" tabindex="0" role="region" aria-label="Hosts serving the same weights"><table id="hosts" data-keep="model,provider,quant,n,score"><thead><tr><th>model</th><th>provider</th><th>quant</th><th>serving mode</th><th class="n">n</th><th class="n">score</th><th class="n">quality</th><th class="n">reliability</th><th class="n tool-error">tool-call error</th><th class="n">p50 latency</th><th class="n">$ / success</th></tr></thead><tbody></tbody></table></div>
</section>

<section id="ran"><span class="section-number">06</span><h2>Where it ran</h2>
<p class="answer" id="ran-answer" aria-live="polite">Loading.</p>
<div class="breakdown" id="breakdown"></div>
</section>
</div>
</main>
<footer>
  <p>score = 0.55 × rating + 0.30 × survival + 0.15 × clean; missing parts are dropped and weights renormalised; n &lt; 3 is never scored. Tiers are relative to the best model in the same field. Change flags compare a week with its trailing four on rating, clean rate, steering, survival and latency; this is change detection, not a verdict. <a href="/board">Board</a> · <a href="/export.json">raw data</a> · <a href="/privacy">privacy</a></p>
</footer>
<script>${READABLE_JS}</script>
<script>${js}</script>
</body>
</html>`);
}
