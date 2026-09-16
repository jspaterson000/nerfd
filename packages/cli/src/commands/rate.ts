import { CATEGORIES, KEPT, SIZES, type Category, type Kept, type Size } from '@nerfd/core';
import { putSession, resolveSession } from '../db.ts';
import { str, type Args } from '../args.ts';
import { loadConfig } from '../paths.ts';
import { publishSession } from '../publish.ts';

/**
 * `nerfd rate [session] [1-5] [kept|partial|reverted] [category] [s|m|l] [note...]`
 * Tokens can come in any order. Whatever is not recognised becomes the note.
 * Designed so `/nerfd 4 kept solid refactor` works from inside Claude Code.
 */
export async function rate(a: Args): Promise<void> {
  const tokens = [...a._];
  const explicit = str(a, 'session');
  let ref: string | undefined = explicit;
  if (!ref && tokens[0] && (tokens[0] === 'last' || /^[0-9a-f-]{6,}$/i.test(tokens[0]))) ref = tokens.shift();
  const s = resolveSession(ref ?? 'last');
  if (!s) { process.stderr.write(`no session matches "${ref ?? 'last'}"\n`); process.exitCode = 1; return; }

  let rating: number | null = null;
  let kept: Kept | null = null;
  let cat: Category | null = str(a, 'cat') as Category ?? null;
  let size: Size | null = str(a, 'size') as Size ?? null;
  const note: string[] = [];
  for (const t of tokens) {
    const low = t.toLowerCase().replace(/^--?/, '');
    if (rating == null && /^[1-5]$/.test(low)) rating = Number(low);
    else if (kept == null && (KEPT as readonly string[]).includes(low) && low !== 'unknown') kept = low as Kept;
    else if (cat == null && (CATEGORIES as readonly string[]).includes(low)) cat = low as Category;
    else if (size == null && (SIZES as readonly string[]).includes(low)) size = low as Size;
    else note.push(t);
  }
  const m = str(a, 'm') ?? str(a, 'note');
  if (m) note.push(m);

  if (rating != null) s.outcome.rating = rating;
  if (kept) s.outcome.kept = kept;
  if (cat) { s.category = cat; s.category_source = 'user'; }
  if (size) s.size = size;
  if (note.length) s.outcome.note = note.join(' ').replace(/^["']|["']$/g, '').slice(0, 500);
  if (rating != null || kept || note.length) s.outcome.rated_at = new Date().toISOString();
  putSession(s);

  process.stdout.write(
    `${s.id.slice(0, 8)}  ${s.tool}  ${s.model ?? '?'}  ${s.category}/${s.size}  rating=${s.outcome.rating ?? '-'}  kept=${s.outcome.kept}` +
      (s.outcome.note ? `  "${s.outcome.note}"` : '') + '\n',
  );
  // A rating changes the public record, so re-send it if it was ever sent.
  const cfg = loadConfig();
  if (s.ended_at && (cfg.share === 'auto' || s.shared_at)) {
    const r = await publishSession(s, cfg);
    if (!r.ok) process.stderr.write(`(not re-shared: ${r.reason})\n`);
  }
}
