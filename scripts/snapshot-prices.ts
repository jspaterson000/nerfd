#!/usr/bin/env node
// Vendors https://models.dev/api.json into packages/core/data/models.dev.json.
//
// Sessions are priced against the snapshot that was in force when they ended,
// never a live table, so this file is committed and dated. Run it weekly.
// Only the fields the scorecard actually uses are kept: the upstream document
// is ~4.7MB and most of it (descriptions, modalities, knowledge cutoffs) is
// not something we price, group or display.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = 'https://models.dev/api.json';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'core', 'data', 'models.dev.json');
const MAX_BYTES = 900 * 1024;

interface RawModel {
  id?: string; name?: string; family?: string; open_weights?: boolean; release_date?: string;
  tool_call?: boolean; reasoning?: boolean;
  modalities?: { output?: string[] };
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
  limit?: { context?: number; output?: number };
}
interface RawProvider { id?: string; name?: string; npm?: string; models?: Record<string, RawModel> }

function trimModel(id: string, m: RawModel, withName: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = { id: m.id ?? id };
  if (withName && m.name) out.name = m.name;
  if (m.family) out.family = m.family;
  const c = m.cost;
  if (c && (typeof c.input === 'number' || typeof c.output === 'number')) {
    const cost: Record<string, number> = {};
    for (const k of ['input', 'output', 'cache_read', 'cache_write'] as const) if (typeof c[k] === 'number') cost[k] = c[k];
    out.cost = cost;
  }
  const l = m.limit;
  if (l && (typeof l.context === 'number' || typeof l.output === 'number')) {
    const limit: Record<string, number> = {};
    if (typeof l.context === 'number') limit.context = l.context;
    if (typeof l.output === 'number') limit.output = l.output;
    out.limit = limit;
  }
  if (typeof m.open_weights === 'boolean') out.open_weights = m.open_weights;
  if (m.release_date) out.release_date = m.release_date;
  if (typeof m.tool_call === 'boolean') out.tool_call = m.tool_call;
  if (typeof m.reasoning === 'boolean') out.reasoning = m.reasoning;
  return out;
}

function build(raw: Record<string, RawProvider>, opts: { withName: boolean; dropEmpty: boolean }): string {
  const providers: Record<string, unknown> = {};
  for (const [pid, p] of Object.entries(raw)) {
    const models: Record<string, unknown> = {};
    for (const [mid, m] of Object.entries(p.models ?? {})) {
      // A coding agent never reports an image, audio or embedding model, and a
      // "cheapest hosted equivalent" that resolved to Whisper would be wrong.
      const out = m.modalities?.output;
      if (out && !out.includes('text')) continue;
      models[mid] = trimModel(mid, m, opts.withName);
    }
    if (opts.dropEmpty && Object.keys(models).length === 0) continue;
    providers[pid] = { id: p.id ?? pid, name: p.name ?? pid, npm: p.npm ?? null, models };
  }
  return JSON.stringify({ fetched_at: new Date().toISOString(), source: SOURCE, providers }) + '\n';
}

async function main(): Promise<void> {
  const res = await fetch(SOURCE, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${SOURCE}: HTTP ${res.status}`);
  const raw = (await res.json()) as Record<string, RawProvider>;

  let text = build(raw, { withName: true, dropEmpty: false });
  let note = 'full';
  if (Buffer.byteLength(text) > MAX_BYTES) {
    // Second pass: the board never renders a provider with no models, and a
    // model's display name is cosmetic. Identity and price are not.
    text = build(raw, { withName: false, dropEmpty: true });
    note = 'trimmed (no model names, empty providers dropped)';
  }
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, text);
  const parsed = JSON.parse(text) as { providers: Record<string, { models: Record<string, unknown> }> };
  const models = Object.values(parsed.providers).reduce((a, p) => a + Object.keys(p.models).length, 0);
  process.stdout.write(`${OUT}\n${Object.keys(parsed.providers).length} providers, ${models} models, ${(Buffer.byteLength(text) / 1024).toFixed(0)}KB, ${note}\n`);
}

main().catch((e) => { process.stderr.write(`${(e as Error).message}\n`); process.exitCode = 1; });
