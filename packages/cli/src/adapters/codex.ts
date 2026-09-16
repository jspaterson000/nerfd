import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Session, Turn } from '@nerfd/core';
import { CODEX_EVENTS, installCodex } from '../hooks/install.ts';
import { codexTurns, findCodexRollout, listCodexRollouts, parseCodexRollout } from '../transcript.ts';
import { backfillSession } from './backfill.ts';
import { attachSignals, emptyLedger, isCanonicalEvent, type Adapter, type HookInput, type LedgerFacts, type NormalisedEvent } from './types.ts';

export const CODEX_DIR = join(homedir(), '.codex');

const EVENT_MAP: Record<string, NormalisedEvent['hook_event_name']> = {
  SessionStart: 'SessionStart',
  UserPromptSubmit: 'UserPromptSubmit',
  PostToolUse: 'PostToolUse',
  PostToolUseFailure: 'PostToolUseFailure',
  Stop: 'Stop',
  StopFailure: 'StopFailure',
  SessionEnd: 'SessionEnd',
  // Codex names its own abort event; it is an interrupt by any other name.
  TurnAborted: 'Interrupt',
  Interrupted: 'Interrupt',
};

export const codexAdapter: Adapter = {
  id: 'codex',
  label: 'Codex',
  hookEvents: CODEX_EVENTS,

  detect: () => existsSync(CODEX_DIR),

  install: (remove = false) => [installCodex(remove)],

  normalise(input: unknown): NormalisedEvent | null {
    if (!input || typeof input !== 'object') return null;
    const i = input as HookInput;
    const name = i.hook_event_name ?? '';
    const mapped = EVENT_MAP[name] ?? (isCanonicalEvent(name) ? name : null);
    if (!mapped) return null;
    return { ...i, hook_event_name: mapped };
  },

  ledger(session: Session): LedgerFacts | null {
    const path = session.transcript_path ?? findCodexRollout(session.id);
    if (!path || !existsSync(path)) return null;
    const facts = parseCodexRollout(path);
    return {
      ...emptyLedger(),
      ...facts,
      raw_model: facts.model,
      raw_provider: 'openai',
      base_url: process.env.OPENAI_BASE_URL ?? null,
      declared_name: null,
    };
  },

  /** Text is read here and dropped when the signals are computed. */
  turns(session: Session): Turn[] {
    const path = session.transcript_path ?? findCodexRollout(session.id);
    return path && existsSync(path) ? codexTurns(path) : [];
  },

  backfill(sinceIso: string): Session[] {
    const out: Session[] = [];
    for (const f of listCodexRollouts(sinceIso)) {
      const facts = parseCodexRollout(f.path);
      const s = backfillSession('codex', f.session_id, f.path, facts, {
        raw_model: facts.model,
        raw_provider: 'openai',
        base_url: null,
        declared_name: null,
      });
      if (!s) continue;
      s.limit_windows = facts.limit_windows;
      attachSignals(s, codexTurns(f.path));
      out.push(s);
    }
    return out;
  },
};
