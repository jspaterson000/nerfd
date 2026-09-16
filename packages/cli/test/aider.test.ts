import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Aider's config and its analytics log both hang off the home directory, and
// the adapter resolves them once at import. So the home directory is moved
// first and the module is loaded after — `os.homedir()` returns $HOME on
// POSIX, which is what makes this testable without stubbing the filesystem.
const HOME = mkdtempSync(join(tmpdir(), 'nerfd-aider-'));
process.env.HOME = HOME;
process.env.NERFD_HOME = join(HOME, '.nerfd');

const {
  AIDER_CONF, AIDER_LOG, aiderAdapter, aiderFacts, aiderLogPath, aiderTurns,
  groupAiderRuns, installAider, providerFromModelId, readAiderLog,
} = await import('../src/adapters/aider.ts');

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'aider', 'analytics.jsonl');
mkdirSync(dirname(AIDER_LOG), { recursive: true });
copyFileSync(FIXTURE, AIDER_LOG);

test('the analytics log parses, and a torn line costs one line', () => {
  const events = readAiderLog(FIXTURE);
  // Eleven well-formed lines; the blank and the half-written one are dropped.
  assert.equal(events.length, 11);
  assert.equal(events[0]!.event, 'launched');
  assert.equal(events[0]!.ts, Date.parse('2026-09-16T08:00:00Z'));  // `time` is epoch seconds
  assert.deepEqual(readAiderLog(join(HOME, 'nothing.jsonl')), []);
});

test('runs are split on `launched`, on a new install id and on a long silence', () => {
  const runs = groupAiderRuns(readAiderLog(FIXTURE));
  assert.equal(runs.length, 2);
  assert.equal(runs[0]!.events.length, 8);
  assert.equal(runs[1]!.events.length, 3);
  // Deterministic ids, so a second backfill adds nothing.
  assert.equal(runs[0]!.id, groupAiderRuns(readAiderLog(FIXTURE))[0]!.id);
  assert.ok(runs[0]!.id.startsWith('aider-'));
  assert.notEqual(runs[0]!.id, runs[1]!.id);
});

test('message_send is the only event with numbers on it, and they add up', () => {
  const [first, second] = groupAiderRuns(readAiderLog(FIXTURE));
  const f = aiderFacts(first!);
  assert.equal(f.turns, 2);
  assert.equal(f.tokens_in, 8200 + 9100);
  assert.equal(f.tokens_out, 640 + 410);
  assert.equal(f.model, 'openrouter/qwen/qwen3-coder');
  assert.equal(f.raw_provider, 'openrouter');
  assert.equal(f.api_errors, 1);        // message_send_exception, counted not read
  assert.equal(f.interrupts, 1);        // exit reason Control-C
  assert.equal(f.first_ts, '2026-09-16T08:00:00.000Z');
  assert.equal(f.last_ts, '2026-09-16T08:05:00.000Z');
  // Aider never writes its version into the log: it rides on the PostHog
  // super-properties, which the file writer does not see.
  assert.equal(f.tool_version, null);

  const g = aiderFacts(second!);
  assert.equal(g.model, 'ollama/qwen3-coder:30b-q4_K_M');
  assert.equal(g.raw_provider, 'ollama');
});

test('LiteLLM prefixes name the provider, including when the model is redacted', () => {
  assert.equal(providerFromModelId('openrouter/qwen/qwen3-coder'), 'openrouter');
  assert.equal(providerFromModelId('ollama/llama3'), 'ollama');
  assert.equal(providerFromModelId('ollama_chat/REDACTED'), 'ollama');
  assert.equal(providerFromModelId('gemini/gemini-3.8-flash'), 'google');
  assert.equal(providerFromModelId('gpt-4o'), null);
  assert.equal(providerFromModelId(null), null);
});

test('aider backfill turns the log into sessions with a resolved model', () => {
  const sessions = aiderAdapter.backfill!('2026-09-01T00:00:00Z');
  assert.equal(sessions.length, 2);
  const [a, b] = sessions;
  assert.equal(a!.tool, 'aider');
  assert.equal(a!.source, 'backfill');
  assert.equal(a!.metrics.tokens_in, 17300);
  assert.equal(a!.duration_s, 300);
  assert.equal(a!.model_ref.family, 'qwen3-coder');
  assert.equal(a!.model_ref.provider, 'openrouter');
  // A local model is priced as local and carries its quantisation.
  assert.equal(b!.model_ref.serving_mode, 'local');
  assert.equal(b!.model_ref.quant, 'q4_K_M');

  // The log carries no prompts, no paths and no repo names, and the exception
  // text - which can quote a prompt - is counted and never copied.
  for (const s of sessions) {
    const json = JSON.stringify(s);
    assert.equal(s.cwd, null);
    assert.equal(s.first_prompt, null);
    assert.ok(!json.includes('billing.py'));
    assert.ok(!json.includes('litellm.APIError'));
  }

  assert.equal(aiderAdapter.backfill!('2026-09-16T12:00:00Z').length, 0);
  assert.equal(aiderAdapter.ledger({ id: sessions[0]!.id } as never)!.turns, 2);
  assert.equal(aiderAdapter.ledger({ id: 'aider-nope-1' } as never), null);
});

test('turns are timestamps and token counts; there is nothing else in the log', () => {
  const sessions = aiderAdapter.backfill!('2026-09-01T00:00:00Z');
  const turns = aiderTurns(sessions[0]!);
  assert.deepEqual(turns.map((t) => t.role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(turns[1]!.output_tokens, 640);
  assert.equal(turns[1]!.model, 'openrouter/qwen/qwen3-coder');
  assert.ok(turns.every((t) => t.text === undefined), 'the analytics log holds no text at all');
});

test('the config keys go in with a backup and a marker, and come back out', () => {
  const conf = join(HOME, 'conf', '.aider.conf.yml');
  mkdirSync(dirname(conf), { recursive: true });
  writeFileSync(conf, ['# my aider config', 'dark-mode: true', 'auto-commits: false', ''].join('\n'));

  installAider(false, conf, '/tmp/log.jsonl');
  const after = readFileSync(conf, 'utf8');
  assert.ok(after.includes('dark-mode: true'), 'the rest of the file is untouched');
  assert.ok(after.includes('analytics-disable: true  # nerfd'));
  assert.ok(after.includes('analytics-log: /tmp/log.jsonl  # nerfd'));
  assert.equal(aiderLogPath(conf), '/tmp/log.jsonl');
  assert.ok(readdirSync(dirname(conf)).some((f) => f.includes('.bak-nerfd-')), 'the original is backed up');

  installAider(false, conf, '/tmp/log.jsonl');       // idempotent
  assert.equal(readFileSync(conf, 'utf8').split('analytics-log:').length - 1, 1);

  installAider(true, conf);
  const removed = readFileSync(conf, 'utf8');
  assert.ok(!removed.includes('analytics-log'));
  assert.ok(!removed.includes('analytics-disable'));
  assert.ok(removed.includes('auto-commits: false'));

  // Someone else's analytics-log is theirs: it is read, never overwritten.
  writeFileSync(conf, 'analytics-log: ~/logs/aider.jsonl\n');
  installAider(false, conf, '/tmp/log.jsonl');
  assert.equal(readFileSync(conf, 'utf8'), 'analytics-log: ~/logs/aider.jsonl\n');
  assert.equal(aiderLogPath(conf), join(HOME, 'logs', 'aider.jsonl'));
});

test('aider has no live path at all', () => {
  assert.equal(aiderAdapter.normalise({ hook_event_name: 'SessionStart', session_id: 'x' }), null);
  assert.equal(aiderAdapter.normalise(null), null);
  assert.deepEqual(aiderAdapter.hookEvents, []);
  assert.equal(AIDER_CONF, join(HOME, '.aider.conf.yml'));
  assert.equal(AIDER_LOG, join(HOME, '.nerfd', 'aider-analytics.jsonl'));
});
