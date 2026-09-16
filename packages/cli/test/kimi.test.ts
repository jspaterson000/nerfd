import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyError, installKimiHooks, installKimiSkill, kimiAdapter, kimiLedgerFrom, kimiTurnsFrom,
  planHint, readKimiConfig, readKimiState, readSessionIndex, resolveKimiModel, KIMI_EVENTS,
} from '../src/adapters/kimi.ts';
import { parseToml, appendBlock, removeBlock, arrayAt, stringAt } from '../src/adapters/kimi/toml.ts';
import { CANONICAL_EVENTS } from '../src/adapters/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, 'fixtures', 'kimi');
const HOME = join(FIX, 'home');
const SESSION = join(HOME, 'sessions', 'wd_models_9f2a1c4b7e33', 'sess_alpha');

// Every detail the fixtures encode was read out of the shipped bundle of
// `@moonshot-ai/kimi-code` 0.43.1 (dist/main.mjs) and the published docs:
// the `[[hooks]]` four-key strict schema, the 20 event names and their stdin
// payloads, `session_index.jsonl` records, `state.json`, and the wire log's
// `usage.record` / `llm.request` / `turn.ended` / `context.append_loop_event`
// shapes with their camelCase `inputOther` / `output` / `inputCacheRead` /
// `inputCacheCreation` counters.

process.env.KIMI_CODE_HOME = HOME;

const hook = (name: string) => JSON.parse(readFileSync(join(FIX, 'hooks', `${name}.json`), 'utf8')) as unknown;
const tmp = () => mkdtempSync(join(tmpdir(), 'nerfd-kimi-'));

// Strings that appear in the fixtures and must never come back out of the
// adapter. Credentials, prompts, titles, paths and error messages.
const SECRETS = [
  'sk-do-not-read-this-ever', 'not-a-real-key',
  'Fix the login page', 'please finish the refactor',
  'old_string not found', 'too many requests while refactoring',
  'someone@example.com', 'export function login',
];

function assertClean(label: string, value: unknown): void {
  const blob = JSON.stringify(value) ?? '';
  for (const s of SECRETS) assert.ok(!blob.includes(s), `${label} leaked ${JSON.stringify(s)}`);
}

// ---------------------------------------------------------------------------
// TOML
// ---------------------------------------------------------------------------

test('the TOML reader finds what the adapter needs and drops credentials on the way', () => {
  const cfg = parseToml(readFileSync(join(HOME, 'config.toml'), 'utf8'));
  assert.equal(stringAt(cfg, 'default_model'), 'kimi-code/k3');
  assert.equal(stringAt(cfg, 'providers', 'managed:kimi-code', 'type'), 'kimi');
  assert.equal(stringAt(cfg, 'providers', 'managed:kimi-code', 'base_url'), 'https://api.kimi.com/coding/v1');
  assert.equal(stringAt(cfg, 'models', 'kimi-code/k3', 'model'), 'k3');
  // The keys the other user wrote survive, including the array of tables.
  assert.equal(arrayAt(cfg, 'hooks').length, 2);
  assert.equal(arrayAt(cfg, 'hooks')[0]!.event, 'PreToolUse');
  assert.equal(arrayAt(cfg, 'hooks')[1]!.matcher, 'task\\.completed');
  assert.equal(arrayAt(cfg, 'permission', 'rules').length, 1);
  // The api keys never materialise, so nothing downstream can print one.
  assertClean('parsed config', cfg);
  assert.equal(stringAt(cfg, 'providers', 'managed:kimi-code', 'api_key'), null);
});

test('the marked block is appended and removed without touching anything else', () => {
  const before = readFileSync(join(HOME, 'config.toml'), 'utf8');
  const withBlock = appendBlock(before, '[[hooks]]\nevent = "Stop"\ncommand = "x"');
  assert.ok(withBlock.includes(before.trimEnd()), 'original content preserved verbatim');
  assert.equal(removeBlock(withBlock).trimEnd(), before.trimEnd());
  // Appending twice replaces rather than duplicates.
  assert.equal(appendBlock(withBlock, '[[hooks]]\nevent = "Stop"\ncommand = "x"'), withBlock);
  // A file with no block is returned unchanged.
  assert.equal(removeBlock(before), before);
});

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

test('install adds our hooks beside other people\'s and uninstall removes exactly ours', () => {
  const home = tmp();
  cpSync(join(HOME, 'config.toml'), join(home, 'config.toml'));
  const env = { KIMI_CODE_HOME: home } as NodeJS.ProcessEnv;
  const original = readFileSync(join(home, 'config.toml'), 'utf8');

  const path = installKimiHooks(false, env);
  assert.equal(path, join(home, 'config.toml'));
  const after = readFileSync(path, 'utf8');
  const cfg = parseToml(after);

  // Both of theirs plus all eight of ours, and the config still parses.
  const hooks = arrayAt(cfg, 'hooks');
  assert.equal(hooks.length, 2 + KIMI_EVENTS.length);
  assert.equal(hooks[0]!.event, 'PreToolUse');
  assert.equal(hooks[1]!.command, "terminal-notifier -title Kimi -message 'Task done'");
  const ours = hooks.slice(2);
  assert.deepEqual(ours.map((h) => h.event), [...KIMI_EVENTS]);
  for (const h of ours) {
    assert.ok(String(h.command).includes('hook kimi'));
    // `[[hooks]]` is strict: exactly these four keys, or the config will not load.
    assert.deepEqual(Object.keys(h).sort(), ['command', 'event', 'timeout']);
    assert.ok(typeof h.timeout === 'number' && h.timeout >= 1 && h.timeout <= 600);
  }
  // Their providers, models and permission rules are untouched.
  assert.equal(stringAt(cfg, 'models', 'kimi-code/k3', 'model'), 'k3');
  assert.equal(arrayAt(cfg, 'permission', 'rules').length, 1);
  assert.ok(after.includes('api_key = "sk-do-not-read-this-ever"'), 'their key was not rewritten');

  // A backup was written before the file changed.
  assert.ok(readdirSync(home).some((f) => f.startsWith('config.toml.bak-nerfd-')));

  // Installing twice is a no-op, not a second copy.
  installKimiHooks(false, env);
  assert.equal(arrayAt(parseToml(readFileSync(path, 'utf8')), 'hooks').length, 2 + KIMI_EVENTS.length);

  // Removing gives the original file back, byte for byte.
  installKimiHooks(true, env);
  assert.equal(readFileSync(path, 'utf8').trimEnd(), original.trimEnd());
});

test('install creates a config for a machine that has none', () => {
  const home = tmp();
  const env = { KIMI_CODE_HOME: home } as NodeJS.ProcessEnv;
  installKimiHooks(false, env);
  const hooks = arrayAt(parseToml(readFileSync(join(home, 'config.toml'), 'utf8')), 'hooks');
  assert.equal(hooks.length, KIMI_EVENTS.length);
  installKimiHooks(true, env);
  assert.equal(arrayAt(parseToml(readFileSync(join(home, 'config.toml'), 'utf8')), 'hooks').length, 0);
});

test('the skill is a SKILL.md that shells out to `nerfd rate last $ARGUMENTS`', () => {
  const root = tmp();
  const path = installKimiSkill(false, root);
  const text = readFileSync(path, 'utf8');
  assert.ok(path.endsWith(join('nerfd', 'SKILL.md')));
  assert.ok(text.startsWith('---\n'));
  assert.ok(text.includes('\nname: nerfd\n'));
  assert.ok(text.includes('\ndisableModelInvocation: true\n'));
  assert.ok(text.includes('\ntype: prompt\n'));
  assert.ok(/rate last \$ARGUMENTS/.test(text));
  installKimiSkill(true, root);
  assert.equal(existsSync(path), false);
});

// ---------------------------------------------------------------------------
// normalise
// ---------------------------------------------------------------------------

test('normalise maps Kimi events onto the canonical vocabulary', () => {
  const cases: Array<[string, string]> = [
    ['session-start', 'SessionStart'],
    ['user-prompt-submit', 'UserPromptSubmit'],
    ['turn-started', 'UserPromptSubmit'],
    ['post-tool-use', 'PostToolUse'],
    ['post-tool-use-failure', 'PostToolUseFailure'],
    ['stop', 'Stop'],
    ['stop-failure', 'StopFailure'],
    ['interrupt', 'Interrupt'],
    ['session-end', 'SessionEnd'],
  ];
  for (const [file, want] of cases) {
    const out = kimiAdapter.normalise(hook(file));
    assert.ok(out, file);
    assert.equal(out!.hook_event_name, want, file);
    assert.ok((CANONICAL_EVENTS as readonly string[]).includes(out!.hook_event_name));
    assert.equal(out!.session_id, 'sess_alpha');
  }
  assert.equal(kimiAdapter.normalise(hook('session-start'))!.model, 'k3');
});

test('normalise ignores the events that are not session outcomes', () => {
  for (const f of ['heartbeat', 'precompact', 'permission-request', 'subagent-stop', 'notification']) {
    assert.equal(kimiAdapter.normalise(hook(f)), null, f);
  }
  assert.equal(kimiAdapter.normalise({ hook_event_name: 'PreToolUse', session_id: 's' }), null);
  assert.equal(kimiAdapter.normalise({ hook_event_name: 'UserPromptQueued', session_id: 's' }), null);
  assert.equal(kimiAdapter.normalise({ session_id: 's' }), null);
  assert.equal(kimiAdapter.normalise(null), null);
  assert.equal(kimiAdapter.normalise('SessionStart'), null);
  assert.equal(kimiAdapter.normalise(['SessionStart']), null);
});

test('normalise drops the session title and reduces error text to a classification', () => {
  const start = kimiAdapter.normalise(hook('session-start'))!;
  assert.equal(start.session_title, undefined);
  assertClean('SessionStart', start);

  // PostToolUseFailure: the payload quotes the tool output, which quotes code.
  const fail = kimiAdapter.normalise(hook('post-tool-use-failure'))!;
  assertClean('PostToolUseFailure', fail);
  assert.equal(fail.tool_name, 'Edit');
  // What survives still matches handler.ts's counters.
  assert.match(String(fail.error), /invalid tool input/);

  // StopFailure carries a flat error_type + error_message pair.
  const stop = kimiAdapter.normalise(hook('stop-failure'))!;
  assertClean('StopFailure', stop);
  assert.equal(stop.error_message, undefined);
  assert.equal(stop.error_type, 'RateLimitError');
  assert.match(String(stop.error), /rate limit/);

  // Interrupt's reason is free text in the schema.
  const int = kimiAdapter.normalise(hook('interrupt'))!;
  assertClean('Interrupt', int);

  // A background turn's "prompt" is a task description, not a human prompt.
  const sys = kimiAdapter.normalise(hook('turn-started-system'))!;
  assert.equal(sys.hook_event_name, 'UserPromptSubmit');
  assert.equal(sys.prompt, undefined);
  // A real user turn keeps it, for the local classifier.
  assert.equal(kimiAdapter.normalise(hook('turn-started'))!.prompt, 'refactor the auth module');

  // Tool payloads still reach the state machine, which hashes the path itself.
  const use = kimiAdapter.normalise(hook('post-tool-use'))!;
  assert.equal(use.tool_name, 'Edit');
  assert.equal((use.tool_input as Record<string, unknown>).file_path, '/Users/someone/dev/models/src/auth/login.ts');
  assert.equal(kimiAdapter.normalise(hook('post-tool-use-bash'))!.tool_output, undefined);
});

test('classifyError returns fixed tokens and never the message', () => {
  assert.match(classifyError('HTTP 429 too many requests for bob@example.com'), /rate limit/);
  assert.match(classifyError({ name: 'TimeoutError', message: 'timed out reading /secret/path' }), /timed out/);
  assert.match(classifyError({ message: 'prompt is too long' }), /context limit/);
  assert.equal(classifyError(undefined), 'error');
  assert.equal(classifyError({ message: 'something went sideways in /home/bob/x.ts' }), 'error');
  for (const bad of ['/home/bob', 'bob@example.com', 'secret', 'sideways']) {
    assert.ok(!classifyError({ message: `${bad} failed` }).includes(bad));
  }
});

// ---------------------------------------------------------------------------
// config resolution
// ---------------------------------------------------------------------------

test('a model alias resolves through [models.*] to a provider, a base url and a plan family', () => {
  const cfg = readKimiConfig({ KIMI_CODE_HOME: HOME } as NodeJS.ProcessEnv);
  const m = resolveKimiModel(cfg, 'kimi-code/k3');
  assert.equal(m.model, 'k3');
  assert.equal(m.provider_id, 'managed:kimi-code');
  assert.equal(m.provider_type, 'kimi');
  assert.equal(m.base_url, 'https://api.kimi.com/coding/v1');
  assert.equal(m.display_name, 'K3');
  assert.equal(m.max_context_size, 1048576);
  assert.equal(planHint(m), 'kimi-code');

  // A bare wire id finds the alias whose `model` field matches.
  assert.equal(resolveKimiModel(cfg, 'kimi-for-coding').provider_id, 'managed:kimi-code');
  // No alias given falls back to default_model.
  assert.equal(resolveKimiModel(cfg, null).model, 'k3');
  // A user's own endpoint is not a plan, and its key is never read.
  const local = resolveKimiModel(cfg, 'local/qwen');
  assert.equal(local.base_url, 'http://localhost:8000/v1');
  assert.equal(planHint(local), null);
  assertClean('resolved models', [m, local]);
});

// ---------------------------------------------------------------------------
// ledger
// ---------------------------------------------------------------------------

test('the ledger reads tokens, turns, latency, interrupts and the open-weight metrics', () => {
  const f = kimiLedgerFrom(SESSION, { KIMI_CODE_HOME: HOME } as NodeJS.ProcessEnv);

  // inputOther excludes the cache figures, so tokens_in adds cache creation
  // the way every other adapter does and cache reads stay separate.
  assert.equal(f.tokens_in, 1200 + 2400 + 900 + 50);
  assert.equal(f.tokens_out, 180 + 90 + 40);
  assert.equal(f.tokens_cache_read, 400 + 1100 + 300);

  // Three `llm.request` records of kind "loop"; the compaction request is not a turn.
  assert.equal(f.turns, 3);
  assert.deepEqual(f.latencies_ms, [9000, 25000, 12000]);

  assert.equal(f.interrupts, 1);              // turn.ended reason "cancelled"
  assert.equal(f.api_errors, 1);              // turn.ended reason "failed"
  assert.equal(f.rate_limit_hits, 1);         // turn.step.retrying, 429
  assert.equal(f.tool_call_errors, 1);        // tool.result isError, invalid input
  assert.equal(f.context_limit_hits, 2);      // one compaction, one context error
  assert.equal(f.timeouts, 0);

  assert.equal(f.model, 'k3');
  assert.equal(f.raw_model, 'k3');
  assert.equal(f.raw_provider, 'kimi-code');  // the "managed:" namespace is stripped
  assert.equal(f.base_url, 'https://api.kimi.com/coding/v1');
  assert.equal(f.declared_name, 'K3');
  assert.equal(f.plan_hint, 'kimi-code');

  assert.equal(f.first_ts, new Date(1758016800000).toISOString());
  assert.equal(f.last_ts, new Date(1758017550000).toISOString());

  // Nothing textual escapes: no prompt, no path, no key, no error message.
  assertClean('ledger', f);
});

test('state.json is read for timestamps only', () => {
  const s = readKimiState(SESSION);
  assert.equal(s.first_ts, new Date(1758016800000).toISOString());
  assert.equal(s.last_ts, new Date(1758017550000).toISOString());
  assert.equal(s.last_turn_reason, 'failed');
  assertClean('state', s);
  assert.deepEqual(Object.keys(s).sort(), ['first_ts', 'last_ts', 'last_turn_reason']);
});

test('the ledger degrades rather than throws on a wire log it does not recognise', () => {
  const dir = tmp();
  const wire = join(dir, 'agents', 'main');
  cpSync(join(SESSION, 'state.json'), join(dir, 'state.json'));
  // A future release that renames every record type.
  mkdirSync(wire, { recursive: true });
  writeFileSync(join(wire, 'wire.jsonl'), [
    JSON.stringify({ type: 'v2.model.reply', time: 1758016810000, usage: { input_tokens: 10, output_tokens: 2 } }),
    JSON.stringify({ type: 'v2.compaction', time: 1758016820000 }),
    JSON.stringify({ type: 'v2.turn.error', time: 1758016830000, error: { name: 'RateLimitError', message: '429' } }),
    '{ truncated',
  ].join('\n'));
  const f = kimiLedgerFrom(dir, { KIMI_CODE_HOME: HOME } as NodeJS.ProcessEnv);
  assert.equal(f.turns, 1);
  assert.equal(f.tokens_in, 10);
  assert.equal(f.tokens_out, 2);
  assert.equal(f.context_limit_hits, 1);
  assert.equal(f.rate_limit_hits, 1);

  // An empty directory is zeroes, not an exception.
  const empty = kimiLedgerFrom(tmp(), { KIMI_CODE_HOME: HOME } as NodeJS.ProcessEnv);
  assert.equal(empty.turns, 0);
  assert.equal(empty.first_ts, null);
  assert.equal(kimiAdapter.ledger({ id: 'nope', cwd: null } as never), null);
});

// ---------------------------------------------------------------------------
// index and backfill
// ---------------------------------------------------------------------------

test('the session index de-duplicates re-indexed sessions and honours tombstones', () => {
  const rows = readSessionIndex({ KIMI_CODE_HOME: HOME } as NodeJS.ProcessEnv);
  assert.deepEqual(rows.map((r) => r.id), ['sess_old', 'sess_alpha']);
  assert.ok(rows.find((r) => r.id === 'sess_alpha')!.dir.endsWith(join('wd_models_9f2a1c4b7e33', 'sess_alpha')));
});

test('backfill builds sessions from the index and skips what is gone', () => {
  const sessions = kimiAdapter.backfill!('2000-01-01T00:00:00Z');
  assert.equal(sessions.length, 1);
  const s = sessions[0]!;
  assert.equal(s.id, 'sess_alpha');
  assert.equal(s.tool, 'kimi');
  assert.equal(s.source, 'backfill');
  assert.equal(s.model, 'k3');
  assert.equal(s.model_ref.raw_provider, 'kimi-code');
  assert.equal(s.metrics.turns, 3);
  assert.equal(s.metrics.tokens_out, 310);
  assert.equal(s.metrics.interrupts, 1);
  assert.equal(s.metrics.context_limit_hits, 2);
  assert.equal(s.repo.lang, 'none');
  assert.equal(s.first_prompt, null);
  assert.equal(s.cwd, null);
  assert.deepEqual(s.touched_files, []);
  assertClean('backfilled session', s);

  // A window that ends before the session was written finds nothing.
  assert.equal(kimiAdapter.backfill!(new Date(Date.now() + 86400000).toISOString()).length, 0);
});

// ---------------------------------------------------------------------------
// turns
// ---------------------------------------------------------------------------

test('turns rebuild the conversation from the loop events', () => {
  const turns = kimiTurnsFrom(SESSION);
  assert.deepEqual(turns.map((t) => t.role), [
    'user', 'assistant', 'tool', 'user', 'assistant', 'tool', 'tool', 'user', 'assistant',
  ]);

  assert.equal(turns[0]!.text, 'finish the refactor in src/auth/login.ts');
  assert.equal(turns[1]!.text, 'I will start by reading the file.');
  assert.equal(turns[1]!.model, 'k3');
  assert.equal(turns[1]!.output_tokens, 180);
  assert.equal(turns[1]!.ends_with_question, false);
  assert.equal(turns[1]!.ts, 1758016809000);

  assert.equal(turns[2]!.tool, 'Read');
  assert.equal(turns[2]!.path, '/Users/someone/dev/models/src/auth/login.ts');
  assert.equal(turns[2]!.ok, true);

  assert.equal(turns[4]!.ends_with_question, true);
  assert.equal(turns[4]!.interrupted, true);
  assert.equal(turns[4]!.output_tokens, 90);

  assert.equal(turns[5]!.tool, 'Edit');
  assert.equal(turns[5]!.ok, false);
  assert.equal(turns[6]!.tool, 'Bash');
  assert.equal(turns[6]!.command, 'pnpm test --filter auth');
  assert.equal(turns[6]!.ok, true);

  assert.equal(turns[8]!.text, 'Done.');
  assert.equal(turns[8]!.output_tokens, 40);

  // A subagent's own wire log is a different agent and is not folded in here.
  assert.ok(turns.every((t) => (t.output_tokens ?? 0) < 99999));
});

// ---------------------------------------------------------------------------
// adapter surface
// ---------------------------------------------------------------------------

test('the adapter declares the id, label and events the rest of the CLI expects', () => {
  assert.equal(kimiAdapter.id, 'kimi');
  assert.equal(kimiAdapter.label, 'Kimi Code');
  assert.deepEqual(kimiAdapter.hookEvents, [...KIMI_EVENTS]);
  assert.equal(typeof kimiAdapter.detect, 'function');
  assert.equal(typeof kimiAdapter.turns, 'function');
  // Detection follows KIMI_CODE_HOME, which the fixtures point at.
  assert.equal(kimiAdapter.detect(), true);
});
