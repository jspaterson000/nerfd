import type { Turn } from '@nerfd/core';
import { emptyLedger, type LedgerFacts } from '../types.ts';
import type { OcMessage, OcPart, OcSession } from './store.ts';

// Turning OpenCode's store into the two things the rest of nerfd wants: the
// ledger facts for one finished session, and the per-turn signal input.

/**
 * The signal layer's input, exactly as `@nerfd/core` defines it. The alias
 * exists so adapters have one name for it; text rides along in memory only
 * and is never written to the local store.
 */
export type AdapterTurn = Turn;

/** Extra facts only OpenCode has. LedgerFacts is extendable; the handler ignores what it does not know. */
export interface OpencodeLedgerFacts extends LedgerFacts {
  thinking_tokens: number;
  tokens_cache_write: number;
  reported_cost_usd: number | null;   // always 0 for user-declared providers; never trusted
  diffLines: { added: number; deleted: number; files: number };
}

const ABORT = 'MessageAbortedError';
const QUOTA_RE = /rate.?limit|429|too many requests|usage limit|hit your limit|(?<!context (window |length )?)limit reached|quota/i;
const OVERLOADED_RE = /overloaded|529|capacity|at capacity/i;
const TIMEOUT_RE = /timed? ?out|ETIMEDOUT|deadline exceeded/i;
const CONTEXT_RE = /context (window|length|limit)|prompt is too long|too many tokens|MessageOutputLengthError|maximum context|output length/i;
// The model emitted a tool call the harness could not use. This is the number
// that differs most between hosts serving the same weights.
const TOOL_ARG_ERROR_RE = /invalid|parse|schema|unknown tool|arguments/i;

const iso = (ms: number | null | undefined): string | null =>
  typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;

const ends = (t: string): boolean => /\?["'`)\]]*\s*$/.test(t.trim());

function partsOf(s: OcSession, m: OcMessage): OcPart[] {
  return s.parts.get(m.id) ?? [];
}

function textOf(parts: OcPart[]): string {
  return parts.filter((p) => p.type === 'text' && p.text).map((p) => p.text!).join('\n');
}

/** The first thing the person typed, for local classification only. Never stored. */
export function firstUserText(s: OcSession): string | null {
  for (const m of s.messages) {
    if (m.role !== 'user') continue;
    const t = textOf(partsOf(s, m));
    if (t.trim()) return t;
  }
  return null;
}

export function opencodeFacts(s: OcSession): OpencodeLedgerFacts {
  const f: OpencodeLedgerFacts = {
    ...emptyLedger(),
    thinking_tokens: 0,
    tokens_cache_write: 0,
    reported_cost_usd: typeof s.row.cost === 'number' ? s.row.cost : null,
    diffLines: {
      added: s.row.summary_additions ?? 0,
      deleted: s.row.summary_deletions ?? 0,
      files: s.row.summary_files ?? 0,
    },
  };
  f.tool_version = /^\d+\.\d+\.\d+$/.test(s.row.version ?? '') ? s.row.version : null;

  // A session that compacted ran out of room, whatever the model said about it.
  if (s.row.time_compacting != null) f.context_limit_hits++;

  let firstMs: number | null = null;
  let lastMs: number | null = null;
  const mark = (ms: number | null): void => {
    if (ms == null || !Number.isFinite(ms) || ms <= 0) return;
    if (firstMs == null || ms < firstMs) firstMs = ms;
    if (lastMs == null || ms > lastMs) lastMs = ms;
  };

  // The clock the model was made to wait on: the last thing that happened
  // before it started answering. Latency measured from there is the number a
  // person actually experiences, not the slice the harness chose to report.
  let boundary: number | null = null;

  for (const m of s.messages) {
    const parts = partsOf(s, m);
    mark(m.created ?? m.time_created);
    mark(m.completed);

    if (m.role === 'user') {
      boundary = m.created ?? m.time_created;
      continue;
    }
    if (m.role !== 'assistant') continue;

    f.turns++;
    if (!f.model && m.modelID) f.model = m.modelID;
    f.tokens_in += m.tokens.input + m.tokens.cache_write;
    f.tokens_out += m.tokens.output;
    f.tokens_cache_read += m.tokens.cache_read;
    f.tokens_cache_write += m.tokens.cache_write;
    f.thinking_tokens += m.tokens.reasoning;

    if (m.error) {
      if (m.error.name === ABORT) f.interrupts++;
      else f.api_errors++;
      if (QUOTA_RE.test(m.error.text)) f.rate_limit_hits++;
      if (OVERLOADED_RE.test(m.error.text)) f.overloaded++;
      if (TIMEOUT_RE.test(m.error.text)) f.timeouts++;
      if (CONTEXT_RE.test(m.error.text)) f.context_limit_hits++;
    }

    if (m.completed != null) {
      const base = boundary != null && boundary <= m.completed ? boundary : m.created;
      if (base != null && m.completed > base) f.latencies_ms.push(m.completed - base);
    }

    for (const p of parts) {
      if (p.type !== 'tool') continue;
      mark(p.start);
      mark(p.end);
      if (p.end != null) boundary = p.end;
      if (p.interrupted) f.interrupts++;
      if (p.status === 'error') {
        const text = p.error ?? '';
        if (!p.interrupted) f.api_errors++;
        if (TOOL_ARG_ERROR_RE.test(text)) f.tool_call_errors++;
        if (QUOTA_RE.test(text)) f.rate_limit_hits++;
        if (OVERLOADED_RE.test(text)) f.overloaded++;
        if (TIMEOUT_RE.test(text)) f.timeouts++;
        if (CONTEXT_RE.test(text)) f.context_limit_hits++;
      }
    }
  }

  // An empty or half-written session still has the row's own totals.
  if (f.turns === 0) {
    f.tokens_in = (s.row.tokens_input ?? 0) + (s.row.tokens_cache_write ?? 0);
    f.tokens_out = s.row.tokens_output ?? 0;
    f.tokens_cache_read = s.row.tokens_cache_read ?? 0;
    f.thinking_tokens = s.row.tokens_reasoning ?? 0;
  }

  mark(s.row.time_created);
  mark(s.row.time_updated);
  f.first_ts = iso(firstMs);
  f.last_ts = iso(lastMs);
  return f;
}

/**
 * The signal-layer input. Text rides along in memory; the caller classifies
 * and drops it. Nothing here is written anywhere.
 */
export function turnsFrom(s: OcSession): AdapterTurn[] {
  const out: AdapterTurn[] = [];
  for (const m of s.messages) {
    const parts = partsOf(s, m);
    const text = textOf(parts);
    const ts = m.created ?? m.time_created;

    if (m.role === 'user') {
      out.push({ role: 'user', ts, ...(text ? { text, ends_with_question: ends(text) } : {}) });
    } else if (m.role === 'assistant') {
      const interrupted = m.error?.name === ABORT;
      out.push({
        role: 'assistant',
        ts,
        ...(text ? { text, ends_with_question: ends(text) } : {}),
        ...(m.modelID ? { model: m.modelID } : {}),
        thinking_tokens: m.tokens.reasoning,
        output_tokens: m.tokens.output,
        ok: !m.error,
        ...(interrupted ? { interrupted: true } : {}),
      });
    }

    for (const p of parts) {
      if (p.type !== 'tool' || !p.tool) continue;
      out.push({
        role: 'tool',
        ts: p.start ?? p.time_created,
        tool: p.tool,
        ...(p.file_path ? { path: p.file_path } : {}),
        ...(p.command ? { command: p.command } : {}),
        ok: p.status === 'completed',
        ...(p.interrupted ? { interrupted: true } : {}),
      });
    }
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}
