import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SIGNAL_VERSION, computeSignals, emptyMetrics, emptyModelRef, emptyOutcome, emptySurvival, signalRates, type Session, type Turn } from '@nerfd/core';
import { adapterFor } from '../src/adapters/registry.ts';
import { attachSignals } from '../src/adapters/types.ts';
import { claudeTurns, codexTurns } from '../src/transcript.ts';

// The wiring, not the detectors: the detectors have their own test in core.
// What is checked here is that a real transcript on disk becomes turns of the
// right shape, that those turns reach computeSignals, and that what lands on
// the session afterwards is counts and nothing else.

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const CLAUDE = join(FIXTURES, 'claude', 'session.jsonl');
const CODEX = join(FIXTURES, 'codex', 'rollout.jsonl');

function session(over: Partial<Session> = {}): Session {
  return {
    id: 's1', tool: 'claude-code', tool_version: null, model: 'claude-opus-5', model_ref: emptyModelRef(),
    effort: null, plan_id: null, plan_usd_month: null, plan_source: 'unknown',
    started_at: '2026-09-16T00:00:00Z', ended_at: '2026-09-16T00:10:00Z', duration_s: 600,
    cwd: null, repo: { lang: 'ts', size: 'm', age: 'established' }, category: 'code',
    category_source: 'inferred', size: 'm', first_prompt: null,
    metrics: emptyMetrics(), outcome: emptyOutcome(), survival: emptySurvival(),
    line_hashes: null, touched_files: [], transcript_path: CLAUDE, shared_at: null,
    price_snapshot_date: null, ...over,
  };
}

test('claudeTurns: one turn per response, tool results become tool turns', () => {
  const turns = claudeTurns(CLAUDE);
  assert.deepEqual(turns.map((t) => t.role), ['user', 'assistant', 'tool', 'assistant', 'tool', 'user', 'assistant']);

  // A subagent transcript and an injected <system-reminder> are not the person.
  assert.equal(turns.filter((t) => t.role === 'user').length, 2);
  assert.ok(!turns.some((t) => (t.text ?? '').includes('subagent')));
  assert.ok(!turns.some((t) => (t.text ?? '').includes('system-reminder')));

  // The thinking block and the text/tool_use block share one requestId, so
  // they are one assistant turn and the usage is counted once.
  const first = turns[1]!;
  assert.equal(first.text, 'I will edit the client.');
  assert.equal(first.thinking_tokens, 120);
  assert.equal(first.output_tokens, 300);
  assert.equal(first.model, 'claude-opus-5');

  // Tool turns carry what the call touched, and whether it worked.
  assert.deepEqual({ ...turns[2] }, { role: 'tool', ts: turns[2]!.ts, tool: 'Edit', ok: true, path: '/repo/src/client.ts' });
  assert.equal(turns[4]!.tool, 'Bash');
  assert.equal(turns[4]!.command, 'pnpm test');
  assert.equal(turns[4]!.ok, false);

  // "[Request interrupted by user]" is not a prompt; it marks the turn it cut.
  const last = turns.at(-1)!;
  assert.equal(last.interrupted, true);
  assert.equal(last.ends_with_question, true);
  assert.ok(!turns.some((t) => t.role === 'user' && (t.text ?? '').includes('Request interrupted')));
});

test('codexTurns: messages, tool calls and the abort event', () => {
  const turns = codexTurns(CODEX);
  assert.deepEqual(turns.map((t) => t.role), ['user', 'assistant', 'tool', 'tool', 'user', 'assistant']);

  // developer messages and the replayed <environment_context> are not prompts.
  assert.equal(turns[0]!.text, 'write a parser for the config file');
  assert.ok(!turns.some((t) => (t.text ?? '').includes('environment_context')));
  assert.ok(!turns.some((t) => (t.text ?? '').includes('developer instructions')));

  // argv is flattened; the output text decides ok.
  assert.equal(turns[2]!.tool, 'shell');
  assert.equal(turns[2]!.command, 'bash -lc pnpm test');
  assert.equal(turns[2]!.ok, false);
  // "exit_code: 0" beats the word "error" appearing nowhere; a patch succeeded.
  assert.equal(turns[3]!.tool, 'apply_patch');
  assert.equal(turns[3]!.path, '/repo/src/parse.ts');
  assert.equal(turns[3]!.ok, true);

  // turn_aborted lands after the message it interrupted.
  assert.equal(turns.at(-1)!.interrupted, true);
});

test('computeSignals over both fixtures counts the same behaviour', () => {
  for (const turns of [claudeTurns(CLAUDE), codexTurns(CODEX)]) {
    const s = computeSignals(turns);
    assert.equal(s.corrections, 1, 'no, that is wrong');
    assert.equal(s.pushback, 1, 'the interrupted assistant turn');
    assert.equal(s.clarifications, 1, 'ended on a question and stopped');
    assert.equal(s.edit_tool_calls, 1);
    assert.equal(s.edits_without_read, 1, 'edited a file it never read');
    assert.equal(s.test_failures_before_pass, 1);
    assert.equal(s.user_turns, 2);
    const r = signalRates(s);
    assert.equal(r.correction_rate, 0.5);
    assert.equal(r.edit_without_read_rate, 1);
  }
  assert.equal(computeSignals(claudeTurns(CLAUDE)).thinking_ratio, 0.2857); // 120 thinking / 420 output, rounded
  assert.equal(computeSignals(codexTurns(CODEX)).thinking_ratio, null); // codex does not report it
});

test('the claude and codex adapters expose turns(), and empty paths are harmless', () => {
  const claude = adapterFor('claude')!;
  const codex = adapterFor('codex')!;
  assert.equal(typeof claude.turns, 'function');
  assert.equal(typeof codex.turns, 'function');
  assert.equal(claude.turns!(session()).length, 7);
  assert.equal(codex.turns!(session({ tool: 'codex', transcript_path: CODEX })).length, 6);
  assert.deepEqual(claude.turns!(session({ transcript_path: null })), []);
  assert.deepEqual(claude.turns!(session({ transcript_path: '/no/such/file.jsonl' })), []);
});

test('attachSignals stores counts, a version and nothing that reads like a transcript', () => {
  const s = session();
  attachSignals(s, adapterFor('claude')!.turns!(s));
  assert.ok(s.signals);
  assert.equal(s.signal_version, SIGNAL_VERSION);
  assert.equal(s.signals!.corrections, 1);
  // The same pass over the turns is the only place active time can come from.
  assert.ok(s.metrics.active_s != null && s.metrics.active_s > 0);

  // The privacy rule, enforced rather than reviewed: there is no string in
  // what gets written to the database.
  for (const [k, v] of Object.entries(s.signals!)) {
    assert.ok(v == null || typeof v === 'number' || typeof v === 'boolean', `${k} is ${typeof v}`);
  }
  const stored = JSON.stringify(s.signals);
  for (const leak of ['retry helper', 'client.ts', 'pnpm test', 'revert']) {
    assert.ok(!stored.includes(leak), `signals leaked ${leak}`);
  }

  // Interrupts are taken as the larger of the hook's count and the
  // transcript's, never the sum, and pushback is not an interrupt count.
  assert.equal(s.metrics.interrupts, 1);
  const hooked = session({ metrics: { ...emptyMetrics(), interrupts: 4 } });
  attachSignals(hooked, adapterFor('claude')!.turns!(hooked));
  assert.equal(hooked.metrics.interrupts, 4);
});

test('attachSignals is inert on an empty transcript and never throws', () => {
  const s = session();
  attachSignals(s, []);
  assert.equal(s.signals, undefined);
  assert.equal(s.signal_version, undefined);
  assert.equal(s.metrics.active_s, null, 'no turns means no claim about active time');

  let seen: string | null = null;
  const bad = [null as unknown as Turn];
  attachSignals(s, bad, (name) => { seen = name; });
  // Either it coped or it reported a name only; both are acceptable, a throw
  // out of finalise is not.
  assert.ok(seen == null || typeof seen === 'string');
});
