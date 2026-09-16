import { PLANS, planById, parsePlan, TOOLS, type Tool } from '@nerfd/core';
import { loadConfig, saveConfig, type Config } from '../paths.ts';
import type { Args } from '../args.ts';
import { table } from '../table.ts';
import {
  declarePlan, DETECTABLE, effectivePlan, normaliseTool, refreshDetections,
  refreshDetectionsIfStale, withDetections, WHY_NOT,
} from '../plandetect/index.ts';

/**
 * `nerfd plan`                       show what each tool is on, detected or declared
 * `nerfd plan detect`                re-run detection now
 * `nerfd plan claude claude-max-20x` declare the plan for a tool (id or $amount)
 * `nerfd plan codex 200`
 * `nerfd plan claude none`           drop the declaration and fall back to detection
 *
 * Detection reads one named, non-secret field per tool and records which file
 * and field it came from; `nerfd privacy` and the table below both show it. A
 * declared plan always wins, because the person knows and the file may not.
 */
export function plan(a: Args): void {
  const cfg = loadConfig();
  const [toolArg, value] = a._;

  if (!toolArg) return show(cfg, false);
  if (toolArg === 'detect' || toolArg === 'redetect') return show(cfg, true, value);
  if (toolArg === 'forget') return forget(cfg, value);

  const tool = normaliseTool(toolArg) ?? (toolArg === 'other' ? 'other' : null);
  if (!tool) {
    process.stderr.write(`unknown tool "${toolArg}". one of: ${TOOLS.join(', ')}\n`);
    process.exitCode = 1;
    return;
  }
  if (!value) {
    process.stderr.write('usage: nerfd plan <tool> <plan-id|$amount|none>   |   nerfd plan detect\n');
    process.exitCode = 1;
    return;
  }

  if (value === 'none') {
    delete cfg.plans[tool];
    saveConfig(cfg);
    const back = effectivePlan(cfg, tool);
    process.stdout.write(
      back.plan_source === 'detected'
        ? `${tool}: declaration cleared. falling back to the detected plan: ${nameOf(back.plan_id)} (${back.evidence}).\n`
        : `${tool}: plan cleared.\n`,
    );
    return;
  }

  const p = parsePlan(value, tool);
  if (!p) {
    process.stderr.write(`unknown plan "${value}". run \`nerfd plan\` to list, or give a monthly dollar amount.\n`);
    process.exitCode = 1;
    return;
  }
  declarePlan(cfg, tool, p);
  saveConfig(cfg);
  process.stdout.write(`${tool}: ${p.name}${p.usd_month == null ? '' : ` ($${p.usd_month}/mo)`}. declared, so it overrides detection. new sessions will carry this.\n`);
}

/** `nerfd plan forget <tool>` drops a stored detection without declaring anything. */
function forget(cfg: Config, toolArg: string | undefined): void {
  const c = withDetections(cfg);
  const tool = toolArg ? normaliseTool(toolArg) : null;
  if (!c.detected_plans) { process.stdout.write('nothing detected to forget.\n'); return; }
  if (tool) delete c.detected_plans.plans[tool];
  else c.detected_plans = { checked_at: new Date().toISOString(), plans: {} };
  saveConfig(cfg);
  process.stdout.write(`forgot the detected plan for ${tool ?? 'every tool'}. \`nerfd plan detect\` re-runs it.\n`);
}

function show(cfg: Config, force: boolean, only?: string): void {
  // Detection is cheap but not free, and a subscription changes about as often
  // as a person changes their mind about one. Once a day is plenty.
  const ranNow = force ? (refreshDetections(cfg), true) : refreshDetectionsIfStale(cfg);
  if (ranNow) saveConfig(cfg);

  const c = withDetections(cfg);
  const detected = c.detected_plans?.plans ?? {};
  const wanted = only ? [normaliseTool(only)].filter(Boolean) as Tool[] : null;

  // Every tool detection knows how to look at, plus anything with a declared
  // plan, plus `other` as the catch-all for tools with no adapter.
  const tools = wanted ?? TOOLS.filter((t) => DETECTABLE.includes(t) || cfg.plans[t] || detected[t] || t === 'other');

  const rows = tools.map((t) => {
    const e = effectivePlan(cfg, t);
    const d = detected[t];
    return [
      t,
      e.plan_id ? nameOf(e.plan_id) : '-',
      priceOf(e.plan_id),
      e.plan_source,
      e.plan_source === 'detected' ? (e.confidence ?? '-') : '-',
      e.plan_source === 'declared' ? 'you typed it' : (d?.evidence ?? WHY_NOT[t] ?? '-'),
    ];
  });

  const out: string[] = [];
  out.push(table(['tool', 'plan', 'price', 'source', 'confidence', 'read from'], rows));
  if (c.detected_plans) out.push(`\nlast detection: ${c.detected_plans.checked_at}${ranNow ? ' (just now)' : ''}. re-run: nerfd plan detect`);

  // Anything ambiguous gets one concrete command rather than a shrug.
  for (const t of tools) {
    const e = effectivePlan(cfg, t);
    if (e.plan_source !== 'detected') continue;
    if (e.plan_id === 'claude-max') {
      out.push('\nclaude: detected Max, but a $100 Max 5x and a $200 Max 20x are identical on disk, so the price is unknown.');
      out.push('        settle it in one command:  nerfd plan claude claude-max-5x   |   nerfd plan claude claude-max-20x');
    } else if (planById(e.plan_id)?.usd_month == null && e.plan_id !== 'api' && e.plan_id !== 'local') {
      out.push(`\n${t}: detected ${nameOf(e.plan_id)}, but nerfd has no list price for it. \`nerfd plan ${t} 150\` sets what you actually pay.`);
    }
  }

  out.push('\nonly the plan id and whether it was detected or declared are ever shared. the "read from" column is local.');
  out.push('\nknown plans:');
  out.push(table(['id', 'tool', 'name', 'price'], PLANS.map((p) => [p.id, p.tool, p.name, p.usd_month == null ? 'usage' : `$${p.usd_month}/mo`])));
  out.push('\ndeclare one: nerfd plan claude claude-max-20x   |   nerfd plan codex chatgpt-pro   |   nerfd plan claude 150');
  process.stdout.write(out.join('\n') + '\n');

}

function nameOf(id: string | null): string {
  if (!id) return '-';
  return planById(id)?.name ?? id;
}

function priceOf(id: string | null): string {
  if (!id) return '-';
  const p = planById(id);
  if (!p) return id.startsWith('custom-') ? `$${id.slice(7)}/mo` : '-';
  return p.usd_month == null ? 'usage' : `$${p.usd_month}/mo`;
}
