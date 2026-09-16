import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COPILOT_EVENTS, copilotAdapter, copilotEventsPath, copilotFacts, copilotHome,
  copilotHookInstalled, copilotTurns, installCopilot, readCopilotEvents,
} from '../src/adapters/copilot.ts';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'copilot');
process.env.COPILOT_HOME = FIX;
const SESSION = 'sess-cp-1';

test('COPILOT_HOME moves the whole directory, and there is no XDG fallback', () => {
  assert.equal(copilotHome({ COPILOT_HOME: '/tmp/cp' }), '/tmp/cp');
  assert.equal(copilotHome({ XDG_CONFIG_HOME: '/tmp/xdg', HOME: '/tmp/h' }).endsWith('.copilot'), true);
  assert.equal(copilotEventsPath(SESSION), join(FIX, 'session-state', SESSION, 'events.jsonl'));
});

test('the Copilot ledger reads the model and token split from session.shutdown', () => {
  const path = copilotEventsPath(SESSION);
  // The log contains a line that is not JSON — Copilot has open bugs about
  // exactly that — and it must cost one line, not the session.
  assert.equal(readCopilotEvents(path).length, 10);

  const f = copilotFacts(path);
  // `inputTokens` is inclusive of the cache read, so the cache is taken back
  // out to leave the three numbers disjoint, as every other adapter has them.
  assert.equal(f.tokens_in, (23399 - 10069) + (1000 - 200));
  assert.equal(f.tokens_out, 2994 + 100);
  assert.equal(f.tokens_cache_read, 10069 + 200);
  // Two models ran; the session belongs to the one that did the work.
  assert.equal(f.model, 'claude-sonnet-4.6');
  assert.equal(f.raw_provider, 'github-copilot');
  assert.equal(f.tool_version, '1.0.85');
  assert.equal(f.turns, 1);
  assert.equal(f.interrupts, 1);
  assert.equal(f.context_limit_hits, 1);
  assert.equal(f.tool_call_errors, 1);
  assert.equal(f.first_ts, '2026-09-16T11:00:00.000Z');
  assert.equal(f.last_ts, '2026-09-16T11:10:00.000Z');
  assert.ok(f.latencies_ms.length >= 1);

  assert.equal(copilotAdapter.ledger({ id: 'no-such' } as never), null);
  assert.equal(copilotAdapter.ledger({ id: SESSION } as never)!.tokens_out, 3094);
});

test('Copilot backfill walks session-state and keeps the record clean', () => {
  const sessions = copilotAdapter.backfill!('2026-01-01T00:00:00Z');
  assert.equal(sessions.length, 1);
  const s = sessions[0]!;
  assert.equal(s.id, SESSION);
  assert.equal(s.tool, 'copilot');
  assert.equal(s.source, 'backfill');
  assert.equal(s.model, 'claude-sonnet-4.6');
  assert.equal(s.model_ref.family, 'claude-sonnet');
  assert.equal(s.model_ref.provider, 'github-copilot');
  assert.equal(s.duration_s, 600);

  const json = JSON.stringify(s);
  assert.equal(s.cwd, null);
  assert.equal(s.first_prompt, null);
  assert.ok(!json.includes('checkout total'), 'no prompt text in a session record');
  assert.ok(!json.includes('/Users/x/acme'), 'no path in a session record');
  assert.ok(!json.includes('npm test'), 'no command in a session record');
});

test('Copilot hooks install as one file we own, and uninstall removes it', () => {
  const home = mkdtempSync(join(tmpdir(), 'nerfd-copilot-'));
  const path = join(home, 'hooks', 'nerfd.json');

  const written = installCopilot(false, path);
  assert.equal(written, path);
  assert.equal(copilotHookInstalled(path), true);
  const file = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(file.version, 1);
  assert.deepEqual(Object.keys(file.hooks).sort(), [...COPILOT_EVENTS].sort());
  // PreToolUse is the one fail-closed event: a hook that errors denies the
  // tool call, so nerfd never registers it.
  assert.ok(!('PreToolUse' in file.hooks), 'never register the fail-closed event');
  const entry = file.hooks.PostToolUse[0];
  assert.equal(entry.type, 'command');
  assert.equal(entry.exec, process.execPath);
  assert.deepEqual(entry.args.slice(-2), ['hook', 'copilot']);
  assert.equal(typeof entry.timeoutSec, 'number');

  installCopilot(false, path);                       // idempotent
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).hooks.PostToolUse.length, 1);

  installCopilot(true, path);
  assert.equal(existsSync(path), false);
  assert.equal(copilotHookInstalled(path), false);
  installCopilot(true, path);                        // removing twice is fine
});

test('Copilot normalise accepts both spellings of every event', () => {
  // Registering the PascalCase name gets the Claude-shaped payload; the
  // camelCase name gets camelCase fields. Both have to land in one vocabulary.
  const pascal = copilotAdapter.normalise({
    hook_event_name: 'PostToolUse', session_id: 's1', cwd: '/p',
    tool_name: 'bash', tool_input: { command: 'ls' },
  })!;
  assert.equal(pascal.hook_event_name, 'PostToolUse');
  assert.equal(pascal.tool_name, 'bash');

  const camel = copilotAdapter.normalise({
    eventName: 'postToolUse', sessionId: 's1', cwd: '/p',
    toolName: 'bash', toolArgs: { command: 'ls' },
  })!;
  assert.equal(camel.hook_event_name, 'PostToolUse');
  assert.equal(camel.session_id, 's1');
  assert.equal(camel.tool_name, 'bash');
  assert.deepEqual(camel.tool_input, { command: 'ls' });

  assert.equal(copilotAdapter.normalise({ eventName: 'sessionEnd', sessionId: 's' })!.hook_event_name, 'SessionEnd');
  assert.equal(copilotAdapter.normalise({ eventName: 'agentStop', sessionId: 's' })!.hook_event_name, 'Stop');
  assert.equal(copilotAdapter.normalise({ eventName: 'errorOccurred', sessionId: 's' })!.hook_event_name, 'StopFailure');
  const transcript = copilotAdapter.normalise({ eventName: 'agentStop', sessionId: 's', transcriptPath: '/t.jsonl' })!;
  assert.equal(transcript.transcript_path, '/t.jsonl');

  // Events with no outcome meaning are not scored.
  assert.equal(copilotAdapter.normalise({ eventName: 'notification', sessionId: 's' }), null);
  assert.equal(copilotAdapter.normalise({ eventName: 'preCompact', sessionId: 's' }), null);
  assert.equal(copilotAdapter.normalise(null), null);
  assert.equal(copilotAdapter.normalise('sessionStart'), null);
});

test('Copilot turns come out in order with tools and interrupts', () => {
  const turns = copilotTurns({ id: SESSION } as never);
  assert.deepEqual(turns.map((t) => t.role), ['user', 'tool', 'tool', 'assistant', 'assistant']);
  assert.equal(turns[0]!.text, 'why does the checkout total round wrong');
  assert.equal(turns[1]!.command, 'npm test -- checkout');
  assert.equal(turns[2]!.ok, false);
  assert.equal(turns[3]!.ends_with_question, true);
  assert.equal(turns[3]!.model, 'claude-sonnet-4.6');
  assert.equal(turns[4]!.interrupted, true);
  assert.deepEqual(copilotTurns({ id: 'missing' } as never), []);
});
