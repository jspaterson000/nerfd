import { parsePlan } from '@nerfd/core';
import { ADAPTERS } from '../adapters/registry.ts';
import { lastStatuslineNote } from '../hooks/install.ts';
import { openDb } from '../db.ts';
import { flag, str, type Args } from '../args.ts';
import { CONFIG_PATH, DB_PATH, loadConfig, saveConfig } from '../paths.ts';
import { planById } from '@nerfd/core';
import { refreshDetections, withDetections } from '../plandetect/index.ts';
import { CONSENT } from './share.ts';

/**
 * `nerfd init [--claude] [--codex] [--remove] [--server URL] [--share] [--no-share]
 *          [--plan-claude claude-max-20x] [--plan-codex chatgpt-pro]`
 * The curl installer calls this with --server and --share.
 */
export function init(a: Args): void {
  const cfg = loadConfig();
  openDb();
  const server = str(a, 'server');
  if (server) cfg.server = server.replace(/\/+$/, '');
  if (flag(a, 'share')) cfg.share = 'auto';
  if (flag(a, 'no-share')) cfg.share = 'never';
  const pc = str(a, 'plan-claude'); if (pc) { const p = parsePlan(pc, 'claude-code'); if (p) cfg.plans['claude-code'] = p; }
  const px = str(a, 'plan-codex'); if (px) { const p = parsePlan(px, 'codex'); if (p) cfg.plans.codex = p; }
  saveConfig(cfg);

  // Read the plan off the tools that already wrote it, once, at install time.
  // One named field per tool, never a token; `nerfd privacy` prints the exact
  // file and field. docs/PLAN-DETECTION.md is the evidence.
  let detected: ReturnType<typeof withDetections>['detected_plans'] = undefined;
  try {
    detected = refreshDetections(cfg).detected_plans;
    saveConfig(cfg);
  } catch { /* detection is a convenience; never fail an install for it */ }

  const remove = flag(a, 'remove');
  // A flag names a tool explicitly; with no flags, install into every tool
  // that is actually on this machine.
  const named = ADAPTERS.filter((x) => flag(a, x.id) || flag(a, x.id.replace(/-code$/, '')));
  const targets = named.length ? named : ADAPTERS.filter((x) => x.detect());

  const lines: string[] = [];
  lines.push(`config   ${CONFIG_PATH}`);
  lines.push(`db       ${DB_PATH}`);
  lines.push(`server   ${cfg.server}`);
  for (const adapter of targets) {
    let where: string[];
    try { where = adapter.install(remove); } catch (e) { lines.push(`${adapter.id.padEnd(12)} failed: ${(e as Error).message}`); continue; }
    lines.push(`${adapter.id.padEnd(12)} ${remove ? 'removed from' : 'hooked via'} ${where.join(', ')}  (+ /nerfd command)`);
    // Claude Code's window state only exists in the status line, so when one
    // was installed where there was none, say so rather than do it quietly.
    if (lastStatuslineNote) lines.push(`         ${lastStatuslineNote}`);
  }
  if (targets.length === 0) lines.push('hooks    none installed (no supported tool found). other tools: `nerfd record --tool <name> ...`');
  const plans = Object.entries(cfg.plans).map(([t, p]) => `${t}=${p!.name}`).join(', ');
  lines.push(`plans    ${plans || 'none declared. detection below; `nerfd plan claude claude-max-20x` overrides it'}`);
  for (const [tool, d] of Object.entries(detected?.plans ?? {})) {
    if (!d?.plan_id) continue;
    lines.push(`         ${tool.padEnd(12)} ${(planById(d.plan_id)?.name ?? d.plan_id).padEnd(22)} ${d.confidence.padEnd(6)} read from ${d.evidence ?? '-'}`);
  }
  lines.push('         only the plan id and whether it was detected or declared are ever shared. `nerfd plan` shows the rest.');
  lines.push('');
  lines.push(cfg.share === 'auto' ? CONSENT : 'sharing  OFF. your data stays local. `nerfd share on` to contribute to the public board.');
  lines.push('');
  lines.push('use your tools as normal. then: nerfd sessions | nerfd rate last 4 kept | nerfd which code | nerfd cost | nerfd dash');
  process.stdout.write(lines.join('\n') + '\n');
}
