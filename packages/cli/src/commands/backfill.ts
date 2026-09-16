import { AUTO_REVIEW_MODEL_RE, isAutomatedSession, registerModelDeclarations, type PlanSource, type Session, type Tool } from '@nerfd/core';
import { ADAPTERS, adapterFor } from '../adapters/registry.ts';
import { flag, str, type Args } from '../args.ts';
import { getSession, listSessions, putSession } from '../db.ts';
import { loadDeclarations } from '../models.ts';
import { loadConfig, saveConfig, type Config } from '../paths.ts';
import { activePeriod, planStamp, refreshDetections } from '../plandetect/index.ts';

/**
 * `nerfd backfill [tool] [--since 90d] [--refresh] [--restamp]`
 *
 * Reads what the tool already wrote before nerfd was installed. A new user
 * gets a populated scorecard immediately instead of in three weeks, and
 * nothing is invented: sessions that already exist are left alone.
 *
 * `--refresh` re-reads the tool's own ledger for sessions already on record
 * and updates the figures derived from it - the behavioural signals and
 * active time - so a detector added after an import does not need a wipe.
 * Nothing the person supplied is touched: rating, kept and survival stay.
 *
 * `--restamp` imports nothing and re-runs the assumed-plan pass over sessions
 * already on record, for when a subscription period has only just become
 * readable. See `assumedStamp`.
 */
export function backfill(a: Args): void {
  registerModelDeclarations(loadDeclarations());
  const since = sinceIso(str(a, 'since') ?? '90d');
  const refresh = flag(a, 'refresh');
  const only = a._[0] ? adapterFor(a._[0]) : null;
  if (a._[0] && !only) { process.stderr.write(`unknown tool "${a._[0]}"\n`); process.exitCode = 1; return; }

  // Re-read the tools' own config first, so a subscription period that has
  // only just appeared on disk is available to stamp with. This is the same
  // sweep the SessionStart hook runs, forced rather than once-a-day, because
  // the whole point of the command is to act on what is there right now.
  const cfg = loadConfig();
  try { refreshDetections(cfg); saveConfig(cfg); } catch { /* detection never fails a backfill */ }

  if (flag(a, 'restamp')) { restamp(cfg, only?.id ?? null); return; }

  const targets = (only ? [only] : ADAPTERS).filter((x) => typeof x.backfill === 'function' && x.detect());
  if (targets.length === 0) { process.stdout.write('no installed tool can be backfilled.\n'); return; }

  for (const adapter of targets) {
    let added = 0, skipped = 0, updated = 0;
    try {
      for (const s of adapter.backfill!(since)) {
        const existing = getSession(s.id);
        if (existing) {
          if (refresh && rederive(existing, s)) updated++;
          else skipped++;
          continue;
        }
        // History has no plan on it, which is why the plans board was empty
        // for every imported session. Where the subscription period is
        // readable and the session ended inside it, the tool's current plan
        // is applied and marked `assumed` - never `detected`, because nothing
        // about the session itself said so.
        stamp(s, cfg);
        putSession(s);
        added++;
      }
    } catch (e) {
      process.stdout.write(`${adapter.label.padEnd(12)} failed: ${(e as Error).message}\n`);
      continue;
    }
    const tail = refresh ? `, ${updated} refreshed` : '';
    process.stdout.write(`${adapter.label.padEnd(12)} ${added} added, ${skipped} already recorded${tail} (since ${since.slice(0, 10)})\n`);
  }
  process.stdout.write('\nbackfilled sessions have no rating and no survival data: the working tree moved on. `nerfd sessions` to see them.\n');
}

/**
 * Copy the figures re-read from the tool's own store onto a session already on
 * record, and save it if anything moved. Only what the ledger derives: the
 * signals and active time. A rating, a kept flag, survival or a category the
 * person set are theirs and are never overwritten.
 *
 * The wall counters are re-read too, but only for a session the backfill
 * itself wrote: those counts came from the transcript in the first place, so
 * re-reading them is the same operation run again. On a session a hook
 * recorded live, the hook's counters stay the source of truth.
 */
function rederive(existing: Session, fresh: Session): boolean {
  const derived = existing.source === 'backfill';
  const before = JSON.stringify([existing.metrics.active_s, existing.metrics.rate_limit_hits, existing.metrics.overloaded, existing.signal_version, existing.signals, existing.limit_windows]);
  if (fresh.metrics.active_s != null) existing.metrics.active_s = fresh.metrics.active_s;
  if (derived) {
    existing.metrics.rate_limit_hits = fresh.metrics.rate_limit_hits;
    existing.metrics.overloaded = fresh.metrics.overloaded;
  }
  if (fresh.signals) {
    existing.signals = fresh.signals;
    existing.signal_version = fresh.signal_version ?? null;
  }
  if (fresh.limit_windows?.length) existing.limit_windows = fresh.limit_windows;
  if (JSON.stringify([existing.metrics.active_s, existing.metrics.rate_limit_hits, existing.metrics.overloaded, existing.signal_version, existing.signals, existing.limit_windows]) === before) return false;
  putSession(existing);
  return true;
}

/**
 * The plan to put on a session that arrived with none.
 *
 * Detection answers "which plan is this machine on **now**". For history that
 * predates the install that is a guess, and a wrong guess puts a $200 price on
 * months of sessions. So it is applied only where the machine can prove the
 * subscription was already running when the session ended: the Codex JWT
 * carries the active window, and Claude Code records when the subscription was
 * created. A session outside that window - or on a tool that records no dates
 * at all - keeps `null` and `unknown`, which is the honest answer.
 *
 * The word published is `assumed`, never `detected`: the board, and anyone
 * reading the open data, can tell the two apart and drop the weaker one.
 */
export function assumedStamp(cfg: Config, tool: Tool, endedAt: string | null):
  { plan_id: string; plan_usd_month: number | null; plan_source: PlanSource } | null {
  if (!endedAt) return null;
  const ended = Date.parse(endedAt);
  if (Number.isNaN(ended)) return null;

  const period = subscriptionPeriod(cfg, tool);
  // No start date means no evidence the subscription covered this session.
  if (!period.from) return null;
  const from = Date.parse(period.from);
  if (Number.isNaN(from) || ended < from) return null;
  if (period.until) {
    const until = Date.parse(period.until);
    if (!Number.isNaN(until) && ended > until) return null;
  }

  const plan = planStamp(cfg, tool);
  if (!plan.plan_id) return null;
  return { plan_id: plan.plan_id, plan_usd_month: plan.plan_usd_month, plan_source: 'assumed' };
}

/**
 * OpenCode has no subscription of its own to date: signed in by OAuth it is
 * spending the Codex or Claude one, so it borrows that period. The OpenCode
 * detector already returns the borrowed detection whole, which usually carries
 * the dates; this covers the case where it did not.
 */
function subscriptionPeriod(cfg: Config, tool: Tool): { from: string | null; until: string | null } {
  const own = activePeriod(cfg, tool);
  if (own.from || tool !== 'opencode') return own;
  return activePeriod(cfg, 'codex');
}

/** Apply the assumed plan to a session that has no plan of its own. */
function stamp(s: Session, cfg: Config): boolean {
  // A plan the person typed, or one read off the tool's config at the time the
  // session ran, is better evidence than this and is never overwritten.
  if (s.plan_source === 'declared' || s.plan_source === 'detected') return false;
  const assumed = assumedStamp(cfg, s.tool, s.ended_at);
  if (!assumed) return false;
  if (s.plan_id === assumed.plan_id && s.plan_source === 'assumed') return false;
  s.plan_id = assumed.plan_id;
  s.plan_usd_month = assumed.plan_usd_month;
  s.plan_source = assumed.plan_source;
  return true;
}

/**
 * Settle `automated` on a session recorded before the flag existed.
 *
 * Same rule as everywhere else, with the same refusal to guess: a model id a
 * tool reserves for its own unattended reviewer settles it outright, and
 * otherwise it takes evidence - a prompt count from a live hook, or user turns
 * from a transcript that could be reconstructed. A session with neither is
 * left alone, because no evidence is not evidence of a robot.
 */
function reflag(s: Session): boolean {
  const before = s.automated ?? false;
  const decided = AUTO_REVIEW_MODEL_RE.test(s.model ?? '')
    || ((s.signals != null || s.metrics.prompts > 0) && isAutomatedSession(s));
  if (decided === before) return false;
  s.automated = decided;
  return true;
}

/**
 * `nerfd backfill --restamp`: re-run the assumed-plan pass over sessions
 * already on record, and settle `automated` on the ones recorded before that
 * flag existed. Imports nothing. Use it after a subscription period becomes
 * readable, or after upgrading a client that could not read one.
 */
function restamp(cfg: Config, only: Tool | null): void {
  let changed = 0, total = 0, flagged = 0;
  for (const s of listSessions({ endedOnly: true })) {
    if (only && s.tool !== only) continue;
    total++;
    const planned = stamp(s, cfg);
    const auto = reflag(s);
    if (!planned && !auto) continue;
    putSession(s);
    if (planned) changed++;
    if (auto) flagged++;
  }
  process.stdout.write(`restamped ${changed}/${total} sessions with an assumed plan.\n`);
  if (flagged) process.stdout.write(`flagged ${flagged} as automated: nobody prompted them, so they no longer rank against steered work.\n`);
  if (changed || flagged) process.stdout.write('these are already-shared records for the most part: `nerfd share all --resend` sends the update to the board.\n');
  else process.stdout.write('nothing to stamp: no readable subscription period, and every session already carries the right plan and flag.\n');
}

/** `90d`, `12w`, `6m`, or an ISO date. */
function sinceIso(input: string): string {
  const m = /^(\d+)([dwm])$/.exec(input.trim());
  if (m) {
    const days = Number(m[1]) * (m[2] === 'd' ? 1 : m[2] === 'w' ? 7 : 30);
    return new Date(Date.now() - days * 86400_000).toISOString();
  }
  const t = Date.parse(input);
  return Number.isNaN(t) ? new Date(Date.now() - 90 * 86400_000).toISOString() : new Date(t).toISOString();
}
