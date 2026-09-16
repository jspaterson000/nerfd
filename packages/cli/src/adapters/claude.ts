import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Session, Turn } from '@nerfd/core';
import { CLAUDE_EVENTS, installClaude } from '../hooks/install.ts';
import { claudeTurns, listClaudeTranscripts, parseClaudeTranscript } from '../transcript.ts';
import { backfillSession } from './backfill.ts';
import { attachSignals, emptyLedger, isCanonicalEvent, type Adapter, type HookInput, type LedgerFacts, type NormalisedEvent } from './types.ts';

export const CLAUDE_DIR = join(homedir(), '.claude');

// Claude Code's event names are the canonical set, because the canonical set
// was taken from them; the mapping is still explicit so an added event does
// not silently become a session metric.
const EVENT_MAP: Record<string, NormalisedEvent['hook_event_name']> = {
  SessionStart: 'SessionStart',
  UserPromptSubmit: 'UserPromptSubmit',
  PostToolUse: 'PostToolUse',
  PostToolUseFailure: 'PostToolUseFailure',
  PostModelSwitch: 'PostModelSwitch',
  Stop: 'Stop',
  StopFailure: 'StopFailure',
  SessionEnd: 'SessionEnd',
  Notification: 'Stop',
};

export const claudeAdapter: Adapter = {
  id: 'claude-code',
  label: 'Claude Code',
  hookEvents: CLAUDE_EVENTS,

  detect: () => existsSync(CLAUDE_DIR),

  install: (remove = false) => [installClaude(remove)],

  normalise(input: unknown): NormalisedEvent | null {
    if (!input || typeof input !== 'object') return null;
    const i = input as HookInput;
    const name = i.hook_event_name ?? '';
    const mapped = EVENT_MAP[name] ?? (isCanonicalEvent(name) ? name : null);
    if (!mapped) return null;
    // Claude Code has no Interrupt hook; the transcript carries the marker and
    // the ledger picks it up at session end.
    return { ...i, hook_event_name: mapped };
  },

  ledger(session: Session): LedgerFacts | null {
    const path = session.transcript_path;
    if (!path || !existsSync(path)) return null;
    const facts = parseClaudeTranscript(path);
    return {
      ...emptyLedger(),
      ...facts,
      raw_model: facts.model,
      // Claude Code talks to Anthropic unless the environment says otherwise,
      // and those variables are set in the shell the hook runs in.
      raw_provider: process.env.CLAUDE_CODE_USE_BEDROCK ? 'amazon-bedrock' : process.env.CLAUDE_CODE_USE_VERTEX ? 'vertex' : 'anthropic',
      base_url: process.env.ANTHROPIC_BASE_URL ?? null,
      declared_name: process.env.ANTHROPIC_MODEL ?? null,
    };
  },

  /** Text is read here and dropped when the signals are computed. */
  turns(session: Session): Turn[] {
    const path = session.transcript_path;
    return path && existsSync(path) ? claudeTurns(path) : [];
  },

  backfill(sinceIso: string): Session[] {
    const out: Session[] = [];
    for (const f of listClaudeTranscripts(sinceIso)) {
      const facts = parseClaudeTranscript(f.path);
      const s = backfillSession('claude-code', f.session_id, f.path, facts, {
        raw_model: facts.model,
        raw_provider: 'anthropic',
        base_url: null,
        declared_name: null,
      });
      if (!s) continue;
      // Backfilled sessions never pass through `finalise`, so the signals are
      // computed here instead.
      attachSignals(s, claudeTurns(f.path));
      out.push(s);
    }
    return out;
  },
};
