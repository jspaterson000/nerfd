import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  clineAdapter, clineDataDir, clineSessionFacts, clineSessionsDir, clineTaskFacts, clineTurns,
  listClineRecords,
} from '../src/adapters/cline.ts';

// One fixture machine with both layouts on it, which is the normal case for
// anyone who used the VS Code extension before the CLI existed.
const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cline');
process.env.CLINE_DATA_DIR = join(FIX, 'data');
process.env.CLINE_GLOBAL_STORAGE = join(FIX, 'globalStorage');
delete process.env.CLINE_SESSION_DATA_DIR;
delete process.env.CLINE_DIR;

const TASK = '1757980800000';
const SESSION = 'sess-abc123';

test('the Cline paths follow its own resolver, env first', () => {
  assert.equal(clineDataDir({ CLINE_DATA_DIR: '/tmp/d' }), '/tmp/d');
  assert.equal(clineDataDir({ CLINE_DIR: '/tmp/c' }), join('/tmp/c', 'data'));
  assert.equal(clineSessionsDir({ CLINE_SESSION_DATA_DIR: '/tmp/s' }), '/tmp/s');
  assert.equal(clineSessionsDir({ CLINE_DATA_DIR: '/tmp/d' }), join('/tmp/d', 'sessions'));
});

test('the Cline ledger sums the usage messages the way Cline itself does', () => {
  const f = clineTaskFacts(join(FIX, 'globalStorage', 'tasks', TASK));

  // api_req_started (no totals yet) + api_req_finished is one request, counted
  // once; cache writes are input tokens; deleted_api_reqs is pruned history
  // whose usage still happened.
  assert.equal(f.turns, 2);
  assert.equal(f.tokens_in, 1200 + 100 + 900 + 50);
  assert.equal(f.tokens_out, 300 + 120 + 10);
  assert.equal(f.tokens_cache_read, 50 + 400);
  assert.equal(f.interrupts, 1);            // cancelReason: user_cancelled
  assert.equal(f.tool_call_errors, 1);      // diff_error
  assert.equal(f.context_limit_hits, 1);    // compaction
  // task_metadata.json states the provider outright; nothing else does.
  assert.equal(f.model, 'qwen/qwen3-coder');
  assert.equal(f.raw_provider, 'openrouter');
  assert.equal(f.first_ts, new Date(1757980800000).toISOString());
  assert.ok(f.latencies_ms.length >= 1);
});

test('the Cline ledger reads an SDK session manifest', () => {
  const f = clineSessionFacts(join(FIX, 'data', 'sessions', SESSION), SESSION);
  assert.equal(f.tokens_in, 510);           // 500 + 10 cache writes
  assert.equal(f.tokens_out, 80);
  assert.equal(f.tokens_cache_read, 20);
  assert.equal(f.turns, 1);
  assert.equal(f.model, 'qwen3-coder:30b');
  assert.equal(f.raw_provider, 'ollama');
  assert.equal(f.first_ts, '2026-09-16T09:00:00.000Z');
  assert.equal(f.last_ts, '2026-09-16T09:12:00.000Z');
});

test('Cline backfill covers both stores, and neither one leaks', () => {
  const found = listClineRecords();
  assert.deepEqual(found.map((r) => r.kind).sort(), ['session', 'task']);

  const sessions = clineAdapter.backfill!('2025-01-01T00:00:00Z');
  assert.equal(sessions.length, 2);
  const sdk = sessions.find((s) => s.id === SESSION)!;
  const task = sessions.find((s) => s.id === TASK)!;

  assert.equal(sdk.tool, 'cline');
  assert.equal(sdk.source, 'backfill');
  assert.equal(sdk.model_ref.provider, 'ollama');
  assert.equal(sdk.model_ref.serving_mode, 'local');
  assert.equal(task.model_ref.provider, 'openrouter');
  assert.equal(task.metrics.tokens_in, 2250);

  for (const s of sessions) {
    const json = JSON.stringify(s);
    assert.equal(s.cwd, null);
    assert.equal(s.first_prompt, null);
    assert.ok(!json.includes('pagination'), 'no prompt text in a session record');
    assert.ok(!json.includes('refactor the payment adapter'), 'no session title either');
    assert.ok(!json.includes('/Users/x/app'), 'no path in a session record');
  }

  // The window is applied to the record's own mtime, so an old fixture still
  // has to be findable by id.
  assert.ok(clineAdapter.ledger({ id: TASK } as never));
  assert.equal(clineAdapter.ledger({ id: 'not-a-task' } as never), null);
});

test('Cline installs nothing and scores no live event', () => {
  // There is no hook surface in either the CLI or the extension. The SDK's
  // `onEvent` usage event is the future live path and is not a hook.
  assert.deepEqual(clineAdapter.install(), []);
  assert.deepEqual(clineAdapter.install(true), []);
  assert.deepEqual(clineAdapter.hookEvents, []);
  assert.equal(clineAdapter.normalise({ hook_event_name: 'SessionStart', session_id: 'x' }), null);
  assert.equal(clineAdapter.normalise(null), null);
});

test('Cline turns carry the text the detectors need and the tool outcomes', () => {
  const turns = clineTurns({ id: TASK } as never);
  assert.equal(turns[0]!.role, 'user');
  assert.equal(turns[0]!.text, 'add pagination to the users list');
  const assistant = turns.find((t) => t.role === 'assistant' && t.text)!;
  assert.equal(assistant.ends_with_question, true);
  assert.equal(assistant.model, 'qwen3-coder');
  const tool = turns.find((t) => t.role === 'tool' && t.tool)!;
  assert.equal(tool.tool, 'editedExistingFile');
  assert.equal(tool.path, '/Users/x/app/src/users.ts');
  assert.ok(turns.some((t) => t.interrupted));

  const sdk = clineTurns({ id: SESSION } as never);
  assert.deepEqual(sdk.map((t) => t.role), ['user', 'assistant']);
  assert.equal(sdk[1]!.model, 'qwen3-coder:30b');
});
