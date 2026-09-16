import { accessSync, constants, existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { classifyPrompt, type Session } from '@nerfd/core';
import { backfillSession } from './backfill.ts';
import { isCanonicalEvent, type Adapter, type HookInput, type NormalisedEvent } from './types.ts';
import { loadOpencodeConfigs, lookupProvider, opencodeConfigDir, opencodeDbPath, type ProviderInfo } from './opencode/config.ts';
import { emptyProviderInfo } from './opencode/config.ts';
import { opencodeFacts, turnsFrom, firstUserText, type AdapterTurn, type OpencodeLedgerFacts } from './opencode/facts.ts';
import { installOpencode } from './opencode/install.ts';
import { listRootSessions, openStore, parseModelColumn, readBody, readSession, type OcSession } from './opencode/store.ts';

// OpenCode is the exception among the tools nerfd captures: no shell hooks,
// a JS plugin instead. The plugin (packages/cli/plugins/opencode/nerfd.js)
// already emits canonical events, so `normalise` is a validator rather than a
// translator, and everything expensive — tokens, latency, the model actually
// used — comes from the tool's own SQLite store at session end.
//
// It also matters more than its user base suggests: it will talk to any
// OpenAI-compatible endpoint, which is where the open-weight sessions are.
// For a custom provider OpenCode reports a cost of 0 and a model id the user
// invented, so the ledger recomputes cost from tokens and hands the resolver
// the base URL and the declared name from the user's own config — the only
// place a quantisation is ever written down.

export type { AdapterTurn, OpencodeLedgerFacts } from './opencode/facts.ts';

/** The plugin already speaks canonical; raw bus names are accepted for a hand-run event. */
const EVENT_MAP: Record<string, NormalisedEvent['hook_event_name']> = {
  'session.created': 'SessionStart',
  'session.idle': 'Stop',
  'session.error': 'StopFailure',
  'session.interrupt': 'Interrupt',
  'session.compacted': 'StopFailure',
  'session.deleted': 'SessionEnd',
  'chat.message': 'UserPromptSubmit',
  'tool.execute.after': 'PostToolUse',
};

/**
 * OpenCode's tool ids are lower case and its own; the state machine keys off
 * the Claude Code names. Mapping here rather than in the plugin keeps the
 * wire format honest about what the tool actually called itself.
 */
const TOOL_NAME_MAP: Record<string, string> = {
  bash: 'Bash', edit: 'Edit', write: 'Write', patch: 'apply_patch', multiedit: 'MultiEdit',
};

function onPath(bin: string): boolean {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  for (const d of dirs) {
    try { accessSync(join(d, bin), constants.X_OK); return true; } catch { /* next */ }
  }
  return false;
}

/** The plugin sends the store path; a session recorded some other way still finds it. */
function storePathFor(session: Session): string {
  const p = session.transcript_path;
  return p && p.endsWith('.db') && existsSync(p) ? p : opencodeDbPath();
}

function identify(oc: OcSession): { raw_model: string | null; raw_provider: string | null; info: ProviderInfo } {
  const m = parseModelColumn(oc.row.model);
  let raw_model = m.id;
  let raw_provider = m.providerID;
  if (!raw_model || !raw_provider) {
    for (const msg of oc.messages) {
      if (msg.role !== 'assistant') continue;
      raw_model ??= msg.modelID;
      raw_provider ??= msg.providerID;
      if (raw_model && raw_provider) break;
    }
  }
  let info = emptyProviderInfo();
  try { info = lookupProvider(loadOpencodeConfigs(oc.row.directory), raw_provider, raw_model); } catch { /* no config is not an error */ }
  return { raw_model, raw_provider, info };
}

function ledgerFrom(oc: OcSession): OpencodeLedgerFacts {
  const facts = opencodeFacts(oc);
  const { raw_model, raw_provider, info } = identify(oc);
  facts.model = raw_model ?? facts.model;
  facts.raw_model = raw_model ?? facts.model;
  facts.raw_provider = raw_provider;
  facts.base_url = info.base_url;
  facts.declared_name = info.declared_name;
  return facts;
}

export const opencodeAdapter: Adapter = {
  id: 'opencode',
  label: 'OpenCode',
  hookEvents: ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'PostModelSwitch', 'Stop', 'StopFailure', 'Interrupt', 'SessionEnd'],

  detect: () => onPath('opencode') || existsSync(opencodeConfigDir()) || existsSync(opencodeDbPath()),

  install: (remove = false) => installOpencode(remove),

  normalise(input: unknown): NormalisedEvent | null {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const i = input as HookInput;
    const name = typeof i.hook_event_name === 'string' ? i.hook_event_name : '';
    const mapped = isCanonicalEvent(name) ? name : (EVENT_MAP[name] ?? null);
    if (!mapped) return null;
    if (typeof i.session_id !== 'string' || !i.session_id) return null;
    const out: NormalisedEvent = { ...i, hook_event_name: mapped };
    if (typeof i.tool_name === 'string') out.tool_name = TOOL_NAME_MAP[i.tool_name.toLowerCase()] ?? i.tool_name;
    if (i.tool_input != null && (typeof i.tool_input !== 'object' || Array.isArray(i.tool_input))) out.tool_input = {};
    return out;
  },

  ledger: opencodeLedger,

  backfill(sinceIso: string): Session[] {
    const since = Date.parse(sinceIso);
    const db = openStore(opencodeDbPath());
    if (!db) return [];
    const out: Session[] = [];
    try {
      for (const row of listRootSessions(db, Number.isNaN(since) ? 0 : since)) {
        const oc: OcSession = { row, ...readBody(db, row.id) };
        const facts = ledgerFrom(oc);
        const s = backfillSession('opencode', row.id, opencodeDbPath(), facts, {
          raw_model: facts.raw_model,
          raw_provider: facts.raw_provider,
          base_url: facts.base_url,
          declared_name: facts.declared_name,
        });
        if (!s) continue;
        // Classified at import time from the first prompt, which is then
        // dropped on the floor: the category is the record, the text is not.
        s.category = classifyPrompt(firstUserText(oc));
        s.source = 'backfill';
        out.push(s);
      }
    } finally {
      try { db.close(); } catch { /* already gone */ }
    }
    return out;
  },
};

/**
 * The ledger, with OpenCode's own extras kept on the concrete type. The
 * adapter interface narrows this to `LedgerFacts`; callers that want the diff
 * line counts or the reasoning-token split call this directly.
 */
export function opencodeLedger(session: Session): OpencodeLedgerFacts | null {
  const db = openStore(storePathFor(session));
  if (!db) return null;
  try {
    const oc = readSession(db, session.id);
    return oc ? ledgerFrom(oc) : null;
  } finally {
    try { db.close(); } catch { /* already gone */ }
  }
}

/**
 * The signal-layer input for one OpenCode session. Separate from `ledger`
 * because the turns carry prompt and output text: they are built on demand,
 * consumed in memory, and never persisted.
 */
export function opencodeTurns(session: Session): AdapterTurn[] {
  const db = openStore(storePathFor(session));
  if (!db) return [];
  try {
    const oc = readSession(db, session.id);
    return oc ? turnsFrom(oc) : [];
  } finally {
    try { db.close(); } catch { /* already gone */ }
  }
}
