import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
// The adapter's turn shape must stay assignable to the signal layer's `Turn`.
import type { Turn } from '@nerfd/core';

// The fixture store is built here rather than committed: it is a binary
// SQLite file, the release tarball excludes `.db`, and a schema written out
// in full is the clearest statement of what the parser expects to find.

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'opencode');

const root = mkdtempSync(join(tmpdir(), 'nerfd-oc-'));
const dataHome = join(root, 'data');
const configHome = join(root, 'config');
mkdirSync(join(dataHome, 'opencode'), { recursive: true });
mkdirSync(join(configHome, 'opencode'), { recursive: true });
cpSync(join(FIXTURES, 'opencode.jsonc'), join(configHome, 'opencode', 'opencode.jsonc'));
process.env.XDG_DATA_HOME = dataHome;
process.env.XDG_CONFIG_HOME = configHome;
delete process.env.OPENCODE_CONFIG;

const { opencodeAdapter, opencodeLedger, opencodeTurns } = await import('../src/adapters/opencode.ts');
const { loadOpencodeConfigs, lookupProvider, stripJsonc, stripSecrets } = await import('../src/adapters/opencode/config.ts');
const { resolveModelRef } = await import('@nerfd/core');

// ---------------------------------------------------------------- fixture

const SCHEMA = `
CREATE TABLE session (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workspace_id TEXT, parent_id TEXT,
  slug TEXT NOT NULL, directory TEXT NOT NULL, path TEXT, title TEXT NOT NULL,
  version TEXT NOT NULL, share_url TEXT, summary_additions INTEGER, summary_deletions INTEGER,
  summary_files INTEGER, summary_diffs TEXT, metadata TEXT, cost REAL DEFAULT 0 NOT NULL,
  tokens_input INTEGER DEFAULT 0 NOT NULL, tokens_output INTEGER DEFAULT 0 NOT NULL,
  tokens_reasoning INTEGER DEFAULT 0 NOT NULL, tokens_cache_read INTEGER DEFAULT 0 NOT NULL,
  tokens_cache_write INTEGER DEFAULT 0 NOT NULL, revert TEXT, permission TEXT, agent TEXT,
  model TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
  time_compacting INTEGER, time_archived INTEGER
);
CREATE TABLE message (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL, data TEXT NOT NULL
);
CREATE TABLE part (
  id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
  time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
);
`;

const T0 = Date.UTC(2026, 8, 16, 10, 0, 0);
const PROMPT = 'Fix the failing test in the billing module?';
const SECRET_PATH = '/Users/someone/work/acme-billing/src/rates.ts';
const DB_PATH = join(dataHome, 'opencode', 'opencode.db');

function build(): void {
  const db = new DatabaseSync(DB_PATH);
  db.exec(SCHEMA);
  const S = db.prepare(`INSERT INTO session
    (id, project_id, parent_id, slug, directory, title, version, summary_additions, summary_deletions,
     summary_files, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read,
     tokens_cache_write, model, time_created, time_updated, time_compacting)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const M = db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)');
  const P = db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)');
  const model = JSON.stringify({ id: 'qwen38-27b-abliterated', providerID: 'qwen-local', variant: 'default' });

  // The session under test: a real shape, with every error kind in it.
  S.run('s1', 'p1', null, 's1', '/Users/someone/work/acme-billing', 'title', '1.18.30',
    12, 3, 2, 0, 1000, 200, 50, 100, 20, model, T0, T0 + 60_000, T0 + 40_000);

  const tokens = (i: number, o: number, r: number, cr: number, cw: number) =>
    ({ input: i, output: o, reasoning: r, cache: { read: cr, write: cw } });

  M.run('m1', 's1', T0, T0, JSON.stringify({ role: 'user', time: { created: T0 } }));
  P.run('p1', 'm1', 's1', T0, T0, JSON.stringify({ type: 'text', text: PROMPT }));

  M.run('m2', 's1', T0 + 500, T0 + 3500, JSON.stringify({
    role: 'assistant', modelID: 'qwen38-27b-abliterated', providerID: 'qwen-local', cost: 0,
    tokens: tokens(1000, 200, 50, 100, 20), time: { created: T0 + 500, completed: T0 + 3500 },
  }));
  P.run('p2', 'm2', 's1', T0 + 600, T0 + 600, JSON.stringify({ type: 'reasoning', text: 'thinking' }));
  P.run('p3', 'm2', 's1', T0 + 1000, T0 + 1500, JSON.stringify({
    type: 'tool', tool: 'bash', callID: 'c1',
    state: { status: 'completed', input: { command: 'pnpm test' }, output: 'ok', metadata: { exit: 0 }, time: { start: T0 + 1000, end: T0 + 1500 } },
  }));
  P.run('p4', 'm2', 's1', T0 + 3400, T0 + 3400, JSON.stringify({ type: 'text', text: 'Fixed it.' }));

  M.run('m3', 's1', T0 + 10_000, T0 + 10_000, JSON.stringify({ role: 'user', time: { created: T0 + 10_000 } }));
  P.run('p5', 'm3', 's1', T0 + 10_000, T0 + 10_000, JSON.stringify({ type: 'text', text: 'now tidy it up' }));

  // Interrupted: the user hit escape. The abort shows up twice, once on the
  // message and once on the running tool; it is still one interrupt each.
  M.run('m4', 's1', T0 + 11_000, T0 + 12_000, JSON.stringify({
    role: 'assistant', modelID: 'qwen38-27b-abliterated', providerID: 'qwen-local',
    tokens: tokens(500, 0, 0, 0, 0), time: { created: T0 + 11_000, completed: T0 + 12_000 },
    error: { name: 'MessageAbortedError', data: { message: 'aborted' } },
  }));
  P.run('p6', 'm4', 's1', T0 + 11_200, T0 + 11_900, JSON.stringify({
    type: 'tool', tool: 'edit', callID: 'c2',
    state: { status: 'error', input: { filePath: SECRET_PATH }, error: 'Tool execution aborted', metadata: { interrupted: true }, time: { start: T0 + 11_200, end: T0 + 11_900 } },
  }));

  M.run('m4u', 's1', T0 + 19_000, T0 + 19_000, JSON.stringify({ role: 'user', time: { created: T0 + 19_000 } }));
  P.run('p5u', 'm4u', 's1', T0 + 19_000, T0 + 19_000, JSON.stringify({ type: 'text', text: 'try again' }));

  // A provider failure that is not the model's fault.
  M.run('m5', 's1', T0 + 20_000, T0 + 21_000, JSON.stringify({
    role: 'assistant', modelID: 'qwen38-27b-abliterated', providerID: 'qwen-local',
    tokens: tokens(0, 0, 0, 0, 0), time: { created: T0 + 20_000, completed: T0 + 21_000 },
    error: { name: 'APIError', data: { message: 'rate limit exceeded, retry later', statusCode: 429 } },
  }));

  M.run('m5u', 's1', T0 + 29_000, T0 + 29_000, JSON.stringify({ role: 'user', time: { created: T0 + 29_000 } }));
  P.run('p6u', 'm5u', 's1', T0 + 29_000, T0 + 29_000, JSON.stringify({ type: 'text', text: 'keep going' }));

  // The model emitted a tool call that would not validate. The open-weight metric.
  M.run('m6', 's1', T0 + 30_000, T0 + 34_000, JSON.stringify({
    role: 'assistant', modelID: 'qwen38-27b-abliterated', providerID: 'qwen-local',
    tokens: tokens(800, 300, 120, 40, 0), time: { created: T0 + 30_000, completed: T0 + 34_000 },
  }));
  P.run('p7', 'm6', 's1', T0 + 31_000, T0 + 31_500, JSON.stringify({
    type: 'tool', tool: 'edit', callID: 'c3',
    state: { status: 'error', input: { filePath: SECRET_PATH }, error: 'AI_InvalidToolArgumentsError: schema validation failed for tool edit', time: { start: T0 + 31_000, end: T0 + 31_500 } },
  }));

  // A sub-agent session: real, but not a session of the user's.
  S.run('s2', 'p1', 's1', 's2', '/Users/someone/work/acme-billing', 'child', '1.18.30',
    0, 0, 0, 0, 0, 0, 0, 0, 0, model, T0 + 5_000, T0 + 6_000, null);
  // Older than any backfill window we will ask for.
  S.run('s3', 'p1', null, 's3', '/Users/someone/work/acme-billing', 'old', '1.18.30',
    0, 0, 0, 0, 10, 10, 0, 0, 0, model, T0 - 400 * 86_400_000, T0 - 400 * 86_400_000, null);
  M.run('m7', 's3', T0 - 400 * 86_400_000, T0 - 400 * 86_400_000, JSON.stringify({
    role: 'assistant', modelID: 'qwen38-27b-abliterated', providerID: 'qwen-local',
    tokens: tokens(10, 10, 0, 0, 0), time: { created: T0 - 400 * 86_400_000, completed: T0 - 400 * 86_400_000 + 1000 },
  }));
  db.close();
}

build();

const session = (id: string) => ({ id, transcript_path: DB_PATH }) as never;

// ---------------------------------------------------------------- tests

test('the config reader strips comments, strips credentials, and finds the declared name', () => {
  assert.equal(stripJsonc('{"a": "// not a comment", /* x */ "b": 1,}'), '{"a": "// not a comment",  "b": 1}');
  const stripped = stripSecrets({ options: { baseURL: 'u', apiKey: 'sk-1', authToken: 't' }, models: { 'donkey-v2': { name: 'n' } } }) as Record<string, never>;
  assert.deepEqual(stripped, { options: { baseURL: 'u' }, models: { 'donkey-v2': { name: 'n' } } });

  const configs = loadOpencodeConfigs(null);
  assert.equal(configs.length, 1);
  assert.equal(JSON.stringify(configs).includes('sk-do-not-read-me'), false, 'no credential survives the read');

  const info = lookupProvider(configs, 'qwen-local', 'qwen38-27b-abliterated');
  assert.equal(info.base_url, 'http://127.0.0.1:8080/v1');
  assert.equal(info.declared_name, 'Qwen 3.8 27B Abliterated AWQ INT4');
  assert.equal(info.npm, '@ai-sdk/openai-compatible');
  assert.equal(lookupProvider(configs, 'nope', 'nope').base_url, null);

  // `{env:VAR}` is OpenCode's own interpolation; unset means unknown, not literal.
  assert.equal(lookupProvider(configs, 'env-provider', 'm1').base_url, null);
  process.env.NERFD_TEST_BASE_URL = 'http://10.0.0.5:9000/v1';
  assert.equal(lookupProvider(loadOpencodeConfigs(null), 'env-provider', 'm1').base_url, 'http://10.0.0.5:9000/v1');
  delete process.env.NERFD_TEST_BASE_URL;
});

test('normalise validates the plugin payload and maps tool names onto the state machine', () => {
  const a = opencodeAdapter;
  assert.equal(a.normalise({ hook_event_name: 'SessionStart', session_id: 's1' })!.hook_event_name, 'SessionStart');
  assert.equal(a.normalise({ hook_event_name: 'Interrupt', session_id: 's1' })!.hook_event_name, 'Interrupt');
  assert.equal(a.normalise({ hook_event_name: 'session.idle', session_id: 's1' })!.hook_event_name, 'Stop');
  assert.equal(a.normalise({ hook_event_name: 'SessionStart' }), null, 'no session id, no session');
  assert.equal(a.normalise({ hook_event_name: 'PreToolUse', session_id: 's1' }), null);
  assert.equal(a.normalise(null), null);
  assert.equal(a.normalise('SessionStart'), null);
  assert.equal(a.normalise([{ hook_event_name: 'SessionStart', session_id: 's' }]), null);

  const t = a.normalise({ hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'bash', tool_input: { command: 'pnpm test' } })!;
  assert.equal(t.tool_name, 'Bash');   // so the test-run counter sees it
  assert.equal(a.normalise({ hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'edit' })!.tool_name, 'Edit');
  assert.equal(a.normalise({ hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'webfetch' })!.tool_name, 'webfetch');
  assert.deepEqual(a.normalise({ hook_event_name: 'PostToolUse', session_id: 's1', tool_input: 'nope' as never })!.tool_input, {});
});

test('the ledger reads tokens, latency, interrupts and the two open-weight metrics', () => {
  const f = opencodeLedger(session('s1'))!;
  assert.ok(f, 'a session in the store has a ledger');

  assert.equal(f.raw_model, 'qwen38-27b-abliterated');
  assert.equal(f.raw_provider, 'qwen-local');
  assert.equal(f.base_url, 'http://127.0.0.1:8080/v1');
  assert.equal(f.declared_name, 'Qwen 3.8 27B Abliterated AWQ INT4');
  assert.equal(f.tool_version, '1.18.30');

  assert.equal(f.turns, 4);
  assert.equal(f.tokens_in, 1000 + 20 + 500 + 0 + 800);  // input plus cache writes
  assert.equal(f.tokens_out, 200 + 300);                 // reasoning is not output
  assert.equal(f.tokens_cache_read, 100 + 40);
  assert.equal(f.thinking_tokens, 50 + 120);

  assert.equal(f.interrupts, 2);          // the aborted message and the aborted tool
  assert.equal(f.api_errors, 2);          // the 429 and the schema failure; the abort is not an error
  assert.equal(f.rate_limit_hits, 1);
  assert.equal(f.tool_call_errors, 1);
  assert.equal(f.context_limit_hits, 1);  // time_compacting is set
  assert.equal(f.timeouts, 0);

  // Latency is measured from when the model was handed the work, not from
  // when the harness chose to start its own clock.
  assert.deepEqual(f.latencies_ms, [3500, 2000, 2000, 5000]);

  assert.equal(f.first_ts, new Date(T0).toISOString());
  assert.equal(f.last_ts, new Date(T0 + 60_000).toISOString());
  assert.deepEqual(f.diffLines, { added: 12, deleted: 3, files: 2 });
  assert.equal(f.reported_cost_usd, 0, 'custom providers always report zero; cost is recomputed');

  assert.equal(opencodeAdapter.ledger(session('nope')), null);
  assert.equal(opencodeLedger(session('nope')), null);
});

test('the declared name is the only evidence that this was a local abliterated int4 model', () => {
  const f = opencodeLedger(session('s1'))!;
  const ref = resolveModelRef(f.raw_model, f.raw_provider, { baseUrl: f.base_url ?? undefined, declaredName: f.declared_name ?? undefined });
  assert.equal(ref.serving_mode, 'local');
  assert.equal(ref.quant, 'awq-int4');
  assert.equal(ref.modified, true);
  assert.equal(ref.size, '27B');
});

test('backfill takes root sessions in the window and nothing else', () => {
  const since = new Date(T0 - 86_400_000).toISOString();
  const out = opencodeAdapter.backfill!(since);
  assert.deepEqual(out.map((s) => s.id), ['s1'], 'no sub-agents, nothing older than the window');

  const s = out[0]!;
  assert.equal(s.tool, 'opencode');
  assert.equal(s.source, 'backfill');
  assert.equal(s.tool_version, '1.18.30');
  assert.equal(s.category, 'debug', 'classified from the first prompt at import time');
  assert.equal(s.metrics.turns, 4);
  assert.equal(s.metrics.interrupts, 2);
  assert.equal(s.metrics.tool_call_errors, 1);
  assert.equal(s.model_ref.quant, 'awq-int4');
  assert.equal(s.model_ref.serving_mode, 'local');
  assert.equal(s.duration_s, 60);

  // Nothing older than the window, and an empty window is empty.
  assert.deepEqual(opencodeAdapter.backfill!(new Date(T0 + 86_400_000).toISOString()), []);
});

test('turns carry the text the signal layer needs, in order, in memory', () => {
  const turns: Turn[] = opencodeTurns(session('s1'));
  assert.deepEqual(turns.map((t) => t.role),
    ['user', 'assistant', 'tool', 'user', 'assistant', 'tool', 'user', 'assistant', 'user', 'assistant', 'tool']);
  for (let i = 1; i < turns.length; i++) assert.ok(turns[i]!.ts >= turns[i - 1]!.ts, 'monotonic');

  const first = turns[0]!;
  assert.equal(first.text, PROMPT);
  assert.equal(first.ends_with_question, true);

  const assistant = turns[1]!;
  assert.equal(assistant.model, 'qwen38-27b-abliterated');
  assert.equal(assistant.thinking_tokens, 50);
  assert.equal(assistant.output_tokens, 200);
  assert.equal(assistant.ok, true);
  assert.equal(assistant.ends_with_question, false);

  const bash = turns[2]!;
  assert.equal(bash.tool, 'bash');
  assert.equal(bash.command, 'pnpm test');
  assert.equal(bash.ok, true);

  const aborted = turns.find((t) => t.interrupted && t.role === 'assistant')!;
  assert.equal(aborted.ok, false);
  const abortedTool = turns.find((t) => t.interrupted && t.role === 'tool')!;
  assert.equal(abortedTool.tool, 'edit');
  assert.equal(abortedTool.path, SECRET_PATH);
  assert.equal(abortedTool.ok, false);

  assert.deepEqual(opencodeTurns(session('nope')), []);
});

test('nothing text-shaped reaches a stored record', () => {
  // The rule is not "we try not to"; it is that the record cannot contain it.
  const s = opencodeAdapter.backfill!(new Date(T0 - 86_400_000).toISOString())[0]!;
  const blob = JSON.stringify(s);
  for (const leak of [PROMPT, 'now tidy it up', 'Fixed it.', SECRET_PATH, 'acme-billing', 'pnpm test', 'Qwen 3.8 27B Abliterated AWQ INT4', 'sk-do-not-read-me']) {
    assert.equal(blob.includes(leak), false, `leaked: ${leak.slice(0, 24)}`);
  }
  assert.equal(s.first_prompt, null);
  assert.equal(s.cwd, null);
  assert.deepEqual(s.touched_files, []);

  // The ledger is facts about a session, not any part of its content.
  const blobF = JSON.stringify(opencodeLedger(session('s1')));
  for (const leak of [PROMPT, SECRET_PATH, 'pnpm test', 'Fixed it.']) {
    assert.equal(blobF.includes(leak), false, `ledger leaked: ${leak.slice(0, 24)}`);
  }

  // The shipped plugin sends a path only so the handler can hash it, and
  // never opens a file of its own.
  const plugin = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'opencode', 'nerfd.js'), 'utf8');
  assert.equal(/writeFile|appendFile|fetch\(|net\.|https?\.request/.test(plugin), false, 'the plugin writes nothing and calls nobody');
});
