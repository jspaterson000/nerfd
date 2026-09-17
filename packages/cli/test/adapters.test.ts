import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADAPTERS, adapterFor } from '../src/adapters/registry.ts';
import { CANONICAL_EVENTS } from '../src/adapters/types.ts';
import { parseClaudeTranscript, parseCodexRollout } from '../src/transcript.ts';
import { codexAutomated } from '../src/adapters/codex.ts';
import { isUnattendedSource } from '../src/adapters/types.ts';

const claude = adapterFor('claude')!;
const codex = adapterFor('codex')!;

test('the registry resolves adapters by id and by the name the hook uses', () => {
  assert.equal(adapterFor('claude')!.id, 'claude-code');
  assert.equal(adapterFor('claude-code')!.id, 'claude-code');
  assert.equal(adapterFor('CODEX')!.id, 'codex');
  assert.equal(adapterFor('nonsense'), null);
  assert.equal(adapterFor(null), null);
  for (const a of ADAPTERS) assert.equal(typeof a.detect, 'function', a.id);
});

test('normalise maps onto the canonical vocabulary and drops the rest', () => {
  for (const ev of ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'PostModelSwitch', 'Stop', 'StopFailure', 'SessionEnd']) {
    const out = claude.normalise({ hook_event_name: ev, session_id: 's1' });
    assert.ok(out, ev);
    assert.ok((CANONICAL_EVENTS as readonly string[]).includes(out!.hook_event_name), ev);
  }
  // PreToolUse is real but carries no outcome; it is not scored.
  assert.equal(claude.normalise({ hook_event_name: 'PreToolUse', session_id: 's1' }), null);
  assert.equal(claude.normalise({ session_id: 's1' }), null);
  assert.equal(claude.normalise(null), null);
  assert.equal(claude.normalise('SessionStart'), null);

  // Every tool names the abort differently; they all mean interrupt.
  assert.equal(codex.normalise({ hook_event_name: 'TurnAborted', session_id: 's' })!.hook_event_name, 'Interrupt');
  assert.equal(codex.normalise({ hook_event_name: 'Interrupt', session_id: 's' })!.hook_event_name, 'Interrupt');

  // The rest of the payload survives untouched.
  const kept = claude.normalise({ hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Edit', tool_input: { file_path: '/x' } })!;
  assert.equal(kept.tool_name, 'Edit');
  assert.deepEqual(kept.tool_input, { file_path: '/x' });
});

test('a 529 overload and a 429 rate limit are counted apart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nerfd-t-'));
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(path, [
    JSON.stringify({ type: 'user', timestamp: '2026-09-16T10:00:00Z', message: { content: 'hi' } }),
    // The provider's fleet was busy. Not the subscription wall.
    JSON.stringify({ type: 'assistant', timestamp: '2026-09-16T10:00:03Z', requestId: 'r1', isApiErrorMessage: true, message: { content: 'API Error: 529 {"type":"overloaded_error","message":"Overloaded"}' } }),
    // The subscription wall.
    JSON.stringify({ type: 'assistant', timestamp: '2026-09-16T10:00:07Z', requestId: 'r2', isApiErrorMessage: true, message: { content: 'API Error: 429 {"type":"rate_limit_error","message":"This request would exceed your rate limit"}' } }),
  ].join('\n'));

  const f = parseClaudeTranscript(path);
  assert.equal(f.api_errors, 2);
  assert.equal(f.overloaded, 1);
  assert.equal(f.rate_limit_hits, 1);
});

test('the Claude ledger counts tool-argument errors and context-limit hits', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nerfd-t-'));
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(path, [
    JSON.stringify({ type: 'user', timestamp: '2026-09-16T10:00:00Z', version: '2.1.0', message: { content: 'hi' } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-09-16T10:00:04Z', requestId: 'r1', message: { model: 'claude-opus-5', usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5 } } }),
    JSON.stringify({ type: 'user', timestamp: '2026-09-16T10:00:05Z', message: { content: [{ type: 'tool_result', is_error: true, content: 'InputValidationError: file_path is required' }] } }),
    JSON.stringify({ type: 'user', timestamp: '2026-09-16T10:00:06Z', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-09-16T10:00:09Z', requestId: 'r2', isApiErrorMessage: true, message: { content: 'prompt is too long: 900000 tokens' } }),
    JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp: '2026-09-16T10:00:10Z' }),
    '',
    '{ not json',
  ].join('\n'));

  const f = parseClaudeTranscript(path);
  assert.equal(f.model, 'claude-opus-5');
  assert.equal(f.tool_version, '2.1.0');
  assert.equal(f.tokens_in, 100);
  assert.equal(f.tokens_out, 20);
  assert.equal(f.tokens_cache_read, 5);
  assert.equal(f.tool_call_errors, 1);
  assert.equal(f.context_limit_hits, 2);   // the api error and the compact boundary
  assert.equal(f.interrupts, 1);
  assert.equal(f.api_errors, 1);
  assert.ok(f.latencies_ms.length >= 1);

  const ledger = claude.ledger({ transcript_path: path } as never)!;
  assert.equal(ledger.raw_model, 'claude-opus-5');
  assert.equal(ledger.raw_provider, 'anthropic');
  assert.equal(ledger.tool_call_errors, 1);
  assert.equal(claude.ledger({ transcript_path: join(dir, 'missing.jsonl') } as never), null);
});

test('the Codex ledger reads totals, limits and malformed tool calls', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nerfd-t-'));
  const path = join(dir, 'rollout.jsonl');
  writeFileSync(path, [
    JSON.stringify({ type: 'session_meta', timestamp: '2026-09-16T10:00:00Z', payload: { cli_version: '0.60.0' } }),
    JSON.stringify({ type: 'turn_context', timestamp: '2026-09-16T10:00:01Z', payload: { model: 'gpt-6-astra' } }),
    JSON.stringify({ type: 'response_item', timestamp: '2026-09-16T10:00:02Z', payload: { type: 'message', role: 'user' } }),
    JSON.stringify({ type: 'response_item', timestamp: '2026-09-16T10:00:07Z', payload: { type: 'message', role: 'assistant' } }),
    JSON.stringify({ type: 'response_item', timestamp: '2026-09-16T10:00:08Z', payload: { type: 'function_call_output', output: 'failed to parse arguments' } }),
    JSON.stringify({ type: 'event_msg', timestamp: '2026-09-16T10:00:09Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 500, output_tokens: 60, cached_input_tokens: 7 } }, rate_limits: { primary: { used_percent: 42, window_minutes: 300 } } } }),
  ].join('\n'));

  const f = parseCodexRollout(path);
  assert.equal(f.model, 'gpt-6-astra');
  assert.equal(f.tokens_in, 500);
  assert.equal(f.tokens_out, 60);
  assert.equal(f.tool_call_errors, 1);
  assert.equal(f.rate_limit_used_pct, 42);
  assert.equal(f.rate_limit_window_min, 300);
  assert.equal(codex.ledger({ id: 'x', transcript_path: path } as never)!.raw_provider, 'openai');
});

const FIXTURES = join(import.meta.dirname, 'fixtures', 'codex');

test('a Codex desktop-app thread is a person, not a robot', () => {
  // The Codex app, the ChatGPT app's Codex view and the VS Code extension all
  // stamp `source: "vscode"`; a real model and real user turns sit behind it.
  const f = parseCodexRollout(join(FIXTURES, 'desktop-rollout.jsonl'));
  assert.equal(f.meta_source, 'vscode');
  assert.equal(f.model, 'gpt-5.6-sol');
  assert.equal(f.tool_version, '0.154.0-alpha.6.2');
  assert.equal(isUnattendedSource('vscode'), false);
  assert.equal(codexAutomated(f.meta_source, f.model), false);
});

test('a Codex subagent thread is unattended whatever kind it is', () => {
  const f = parseCodexRollout(join(FIXTURES, 'subagent-rollout.jsonl'));
  assert.equal(f.meta_source, 'subagent');
  assert.equal(isUnattendedSource('subagent'), true);
  assert.equal(codexAutomated(f.meta_source, f.model), true);
  // The other shapes still parse.
  assert.equal(codexAutomated('exec', 'gpt-6-astra'), true);
  assert.equal(codexAutomated('cli', 'gpt-6-astra'), false);
  assert.equal(codexAutomated(null, 'gpt-6-astra'), false);
  assert.equal(codexAutomated(null, 'codex-auto-review'), true);
});
