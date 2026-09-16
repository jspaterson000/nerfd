import { CATEGORIES, emptyMetrics, emptyOutcome, emptySurvival, priceSnapshotDate, resolveModelRef, TOOLS, type Category, type Kept, type Session, type Tool } from '@nerfd/core';
import { putSession } from '../db.ts';
import { repoProfile } from '../git.ts';
import { flag, num, str, type Args } from '../args.ts';
import { loadConfig } from '../paths.ts';
import { publishSession } from '../publish.ts';

/**
 * `nerfd record --tool aider --model gpt-6 --cat code --duration 900 --rating 4 --kept
 *            [--tokens-in N --tokens-out N --errors N --prompts N --edits N]`
 *
 * The generic adapter. Any tool, wrapper, or script that knows what happened
 * in a session can report it with one command. Same schema, same redaction,
 * same rules as the hooks. Also usable by a tool's own slash command.
 */
export async function record(a: Args): Promise<void> {
  const toolArg = str(a, 'tool') ?? 'other';
  const tool: Tool = toolArg === 'claude' ? 'claude-code' : ((TOOLS as readonly string[]).includes(toolArg) ? (toolArg as Tool) : 'other');
  const model = str(a, 'model');
  if (!model) { process.stderr.write('usage: nerfd record --tool <name> --model <id> [--cat code] [--duration 900] [--rating 4] [--kept|--reverted] [--tokens-in N --tokens-out N ...]\n'); process.exitCode = 1; return; }
  const cat = (str(a, 'cat') ?? 'other') as Category;
  if (!(CATEGORIES as readonly string[]).includes(cat)) { process.stderr.write(`category must be one of ${CATEGORIES.join(', ')}\n`); process.exitCode = 1; return; }

  const cfg = loadConfig();
  const cwd = str(a, 'cwd') ?? process.cwd();
  const duration = num(a, 'duration', 0);
  const now = Date.now();
  const kept: Kept = flag(a, 'kept') ? 'kept' : flag(a, 'reverted') ? 'reverted' : flag(a, 'partial') ? 'partial' : 'unknown';
  const rating = num(a, 'rating', 0);
  const plan = cfg.plans[tool] ?? cfg.plans.other ?? null;

  const s: Session = {
    id: `rec-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    tool,
    tool_version: str(a, 'tool-version') ?? (tool === 'other' ? toolArg : null),
    model,
    model_ref: resolveModelRef(model, str(a, 'provider') ?? null, { baseUrl: str(a, 'base-url'), declaredName: str(a, 'model-name') }),
    effort: str(a, 'effort') ?? null,
    plan_id: plan?.id ?? null,
    plan_usd_month: plan?.usd_month ?? null,
    // A plan in config.json got there because somebody typed it.
    plan_source: plan ? 'declared' : 'unknown',
    started_at: new Date(now - duration * 1000).toISOString(),
    ended_at: new Date(now).toISOString(),
    duration_s: duration,
    cwd,
    repo: repoProfile(cwd),
    category: cat,
    category_source: 'user',
    size: (str(a, 'size') as Session['size']) ?? (duration > 2700 ? 'l' : duration > 600 ? 'm' : 's'),
    first_prompt: null,
    metrics: {
      ...emptyMetrics(),
      prompts: num(a, 'prompts', 1),
      turns: num(a, 'turns', 0),
      tool_calls: num(a, 'tool-calls', 0),
      edits: num(a, 'edits', 0),
      errors: num(a, 'errors', 0),
      rate_limit_hits: num(a, 'rate-limits', 0),
      interrupts: num(a, 'interrupts', 0),
      tokens_in: num(a, 'tokens-in', 0),
      tokens_out: num(a, 'tokens-out', 0),
      tokens_cache_read: num(a, 'tokens-cache', 0),
      latency_p50_ms: a['latency'] != null ? num(a, 'latency', 0) : null,
    },
    outcome: { ...emptyOutcome(), rating: rating >= 1 && rating <= 5 ? rating : null, kept, note: str(a, 'note') ?? null, rated_at: rating ? new Date().toISOString() : null },
    survival: emptySurvival(),
    line_hashes: null,
    touched_files: [],
    transcript_path: null,
    shared_at: null,
    price_snapshot_date: priceSnapshotDate(),
    source: 'record',
    // Somebody sat down and typed this one in, whatever `--prompts` says.
    automated: false,
  };
  putSession(s);
  process.stdout.write(`recorded ${s.id}  ${tool}  ${model}  ${cat}/${s.size}  rating=${s.outcome.rating ?? '-'}  kept=${kept}\n`);
  if (cfg.share === 'auto' || flag(a, 'share')) {
    const r = await publishSession(s, cfg);
    process.stdout.write(r.ok ? `shared to ${cfg.server}\n` : `not shared: ${r.reason}\n`);
  }
}
