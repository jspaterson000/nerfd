// The weekly drift report: one post, the same shape every week, composed
// from the public endpoints and nothing else. Numbers only, always n, never
// an adjective about a lab, never "nerfed" in our own voice. Everything
// here is also on the board, so anyone can check the post against the page.

export interface WeeklyInputs {
  week: string;                     // ISO week the post is about
  origin: string;                   // https://nerfd.org
  meta: { reports: number; reporter_weeks?: number; reporters?: number; models: string[] };
  thisWeek: { n: number };
  drift: { models: Array<{ model: string; drift: { flag: string; current: { week: string; n: number; score: number | null }; rating_z: number | null; friction_z: number | null; steering_z: number | null; latency_z: number | null } | null; weekly: Array<{ week: string; n: number; score: number | null }> }> };
  work: { min_n: number; work: Array<{ category: string; n: number; ranked: Array<{ model: string; tier: string; score: number | null; n: number }> }> };
  limits: { plans: Array<{ plan_id: string; name?: string; usd_month: number | null; tokens_per_dollar: { p50: number | null } | null; wall_hit_share: number; n: number }> };
}

export interface WeeklyPost { text: string; lines: string[]; card: string }

const WORK_NAMES: Record<string, string> = { code: 'writing code', debug: 'debugging', refactor: 'refactoring', review: 'review', ux: 'UI', strategy: 'planning', writing: 'docs', research: 'research', ops: 'infra', other: 'unclassified' };
const workName = (c: string) => WORK_NAMES[c] ?? c;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const z = (v: number | null) => (finite(v) ? (v > 0 ? '+' : '') + v.toFixed(1) : '–');
const tokens = (v: number | null) => { if (!finite(v)) return '–'; const u = v >= 1e9 ? [1e9, 'B'] as const : v >= 1e6 ? [1e6, 'M'] as const : v >= 1e3 ? [1e3, 'K'] as const : [1, ''] as const; return Number((v / u[0]).toFixed(1)) + u[1]; };

/** Which metric moved most, in the bad direction, for the sentence. */
function worstMove(d: NonNullable<WeeklyInputs['drift']['models'][number]['drift']>): string | null {
  const moves: Array<[string, number]> = [];
  if (finite(d.rating_z) && d.rating_z <= -2) moves.push(['ratings down', -d.rating_z]);
  if (finite(d.friction_z) && d.friction_z <= -2) moves.push(['clean sessions down', -d.friction_z]);
  if (finite(d.steering_z) && d.steering_z >= 2) moves.push(['steering up', d.steering_z]);
  if (finite(d.latency_z) && d.latency_z >= 2) moves.push(['latency up', d.latency_z]);
  if (!moves.length) return null;
  moves.sort((a, b) => b[1] - a[1]);
  return `${moves[0]![0]}, z ${z(moves[0]![1] * (moves[0]![0].endsWith('down') ? -1 : 1))}`;
}

export function composeWeekly(i: WeeklyInputs): WeeklyPost {
  const rw = i.meta.reporter_weeks ?? i.meta.reporters ?? 0;
  const lines: string[] = [];
  lines.push(`Week ${i.week.replace(/^\d{4}-/, '')}. ${i.thisWeek.n} sessions this week, ${i.meta.reports} on record, ${i.meta.models.length} models, ${rw} reporter-week${rw === 1 ? '' : 's'}.`);

  const flagged = i.drift.models.filter((m) => m.drift && (m.drift.flag === 'watch' || m.drift.flag === 'alert'));
  const eligible = i.drift.models.filter((m) => m.drift && m.drift.current.n >= 5);
  if (flagged.length) {
    const parts = flagged.slice(0, 3).map((m) => {
      const d = m.drift!;
      const prev = m.weekly.filter((w) => w.week < d.current.week && finite(w.score)).at(-1);
      const scoreBit = finite(d.current.score) ? `score ${d.current.score}${prev && finite(prev.score) ? ` from ${prev.score}` : ''}` : 'unscored';
      const move = worstMove(d);
      return `${m.model} ${d.flag}: ${scoreBit} (n=${d.current.n}${move ? `, ${move}` : ''})`;
    });
    lines.push(`Moved against their own last four weeks: ${parts.join('; ')}.${eligible.length > flagged.length ? ` Flat: ${eligible.length - flagged.length} other${eligible.length - flagged.length === 1 ? '' : 's'} with 5+ sessions.` : ''}`);
  } else if (eligible.length) {
    lines.push(`No model moved against its own last four weeks (${eligible.length} with 5+ sessions this week).`);
  } else {
    lines.push('Too few sessions this week to test any model for change; a flag needs five.');
  }

  const led = i.work.work.filter((c) => c.ranked.some((r) => r.tier !== '-')).slice(0, 3);
  if (led.length) {
    lines.push(`Best at each kind of work: ${led.map((c) => { const r = c.ranked.find((r) => r.tier !== '-')!; return `${workName(c.category)} ${r.model} (${r.tier}${finite(r.score) ? ` ${r.score}` : ''}, n=${r.n})`; }).join('; ')}.`);
  }

  const plan = i.limits.plans.filter((p) => finite(p.tokens_per_dollar?.p50 ?? null)).sort((a, b) => (b.tokens_per_dollar!.p50! - a.tokens_per_dollar!.p50!))[0];
  if (plan) {
    lines.push(`Most tokens per dollar: ${plan.name ?? plan.plan_id}, ${tokens(plan.tokens_per_dollar!.p50)} per $ (median, n=${plan.n}); wall hit in ${Math.round(plan.wall_hit_share * 100)}% of reporter-weeks.`);
  }

  lines.push(`Change detection, not a verdict: n and z on everything. ${i.origin}/board`);
  return { text: lines.join('\n\n'), lines, card: card(i, lines) };
}

function esc(s: string): string { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!)); }

function wrap(text: string, limit: number): string[] {
  const out: string[] = []; let line = '';
  for (const word of text.split(/\s+/)) { if ((line + ' ' + word).trim().length > limit && line) { out.push(line); line = word; } else line = (line + ' ' + word).trim(); }
  if (line) out.push(line);
  return out;
}

/** The post as a 1200x630 card: the same lines, set large, with the week as the title. */
function card(i: WeeklyInputs, lines: string[]): string {
  const body = lines.slice(1, -1).flatMap((l) => [...wrap(l, 92), '']);
  const rows = body.slice(0, 13).map((t, k) => `<text x="68" y="${200 + k * 27}" font-size="19" fill="${t ? '#242528' : 'none'}">${esc(t)}</text>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="${esc(lines[0]!)}"><rect width="1200" height="630" fill="#fbfbfc"/><g font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif"><rect x="68" y="55" width="36" height="36" rx="10" fill="#242528"/><text x="78" y="82" fill="#fbfbfc" font-size="29">n</text><text x="116" y="82" fill="#242528" font-size="27" font-weight="600">nerfd.ai</text><text x="1132" y="80" text-anchor="end" fill="#686a70" font-size="15" letter-spacing="2">WEEKLY DRIFT REPORT</text><path d="M68 116H1132M68 546H1132" stroke="#e2e3e6"/><text x="68" y="160" font-size="30" font-weight="600" fill="#242528">${esc(lines[0]!)}</text>${rows}<text x="68" y="585" font-size="17" fill="#686a70">Change detection, not a verdict. n and z on everything.</text><text x="1132" y="585" text-anchor="end" font-size="19" font-weight="500" fill="#242528">${esc(i.origin.replace(/^https?:\/\//, ''))}/board ↗</text></g></svg>`;
}
