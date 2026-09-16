import { registerModelDeclarations, type Session } from '@nerfd/core';
import { ADAPTERS, adapterFor } from '../adapters/registry.ts';
import { flag, str, type Args } from '../args.ts';
import { getSession, putSession } from '../db.ts';
import { loadDeclarations } from '../models.ts';

/**
 * `nerfd backfill [tool] [--since 90d] [--refresh]`
 *
 * Reads what the tool already wrote before nerfd was installed. A new user
 * gets a populated scorecard immediately instead of in three weeks, and
 * nothing is invented: sessions that already exist are left alone.
 *
 * `--refresh` re-reads the tool's own ledger for sessions already on record
 * and updates the figures derived from it - the behavioural signals and
 * active time - so a detector added after an import does not need a wipe.
 * Nothing the person supplied is touched: rating, kept and survival stay.
 */
export function backfill(a: Args): void {
  registerModelDeclarations(loadDeclarations());
  const since = sinceIso(str(a, 'since') ?? '90d');
  const refresh = flag(a, 'refresh');
  const only = a._[0] ? adapterFor(a._[0]) : null;
  if (a._[0] && !only) { process.stderr.write(`unknown tool "${a._[0]}"\n`); process.exitCode = 1; return; }

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
 */
function rederive(existing: Session, fresh: Session): boolean {
  const before = JSON.stringify([existing.metrics.active_s, existing.signal_version, existing.signals]);
  if (fresh.metrics.active_s != null) existing.metrics.active_s = fresh.metrics.active_s;
  if (fresh.signals) {
    existing.signals = fresh.signals;
    existing.signal_version = fresh.signal_version ?? null;
  }
  if (JSON.stringify([existing.metrics.active_s, existing.signal_version, existing.signals]) === before) return false;
  putSession(existing);
  return true;
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
