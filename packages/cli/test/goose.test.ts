import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Session } from '@nerfd/core';
import { gooseAdapter, gooseTurns } from '../src/adapters/goose.ts';
import { GOOSE_EVENTS, installGoose, gooseHooksInstalled } from '../src/adapters/goose/install.ts';
import { readGooseConfig } from '../src/adapters/goose/config.ts';
import { parseSimpleYaml } from '../src/adapters/goose/yaml.ts';
import { CANONICAL_EVENTS } from '../src/adapters/types.ts';

// Goose is not installed on the machine that wrote this, so every fixture is
// built here from the schema and payloads verified in Goose's own source:
// session_manager.rs (schema v16), hooks/mod.rs (payload) and the hooks guide.

// --- schema v16, copied from crates/goose/src/session/session_manager.rs ---
const SCHEMA = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
  user_set_name BOOLEAN DEFAULT FALSE, session_type TEXT NOT NULL DEFAULT 'user',
  working_dir TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, extension_data TEXT DEFAULT '{}',
  total_tokens INTEGER, input_tokens INTEGER, output_tokens INTEGER,
  cache_read_tokens INTEGER, cache_write_tokens INTEGER,
  accumulated_total_tokens INTEGER, accumulated_input_tokens INTEGER,
  accumulated_output_tokens INTEGER, accumulated_cache_read_tokens INTEGER,
  accumulated_cache_write_tokens INTEGER, accumulated_cost REAL, schedule_id TEXT,
  recipe_json TEXT, user_recipe_values_json TEXT, provider_name TEXT,
  model_config_json TEXT, goose_mode TEXT NOT NULL DEFAULT 'auto',
  archived_at TIMESTAMP, project_id TEXT, parent_session_id TEXT
);
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT,
  session_id TEXT NOT NULL REFERENCES sessions(id), role TEXT NOT NULL,
  content_json TEXT NOT NULL, created_timestamp INTEGER NOT NULL,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP, tokens INTEGER, metadata_json TEXT
);
CREATE TABLE usage_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  created_timestamp INTEGER NOT NULL, model TEXT, input_tokens INTEGER,
  output_tokens INTEGER, total_tokens INTEGER, cache_read_tokens INTEGER,
  cache_write_tokens INTEGER, cost REAL, cost_source TEXT, is_compaction INTEGER DEFAULT 0
);
`;

const T0 = 1_780_000_000; // a round epoch-seconds base

const CONFIG_YAML = [
  '# goose config',
  'active_provider: openrouter',
  'providers:',
  '  openrouter:',
  '    enabled: true',
  '    model: qwen/qwen3-coder',
  '    configured: true',
  '  ollama:',
  '    enabled: false',
  '    model: "qwen3:30b-q4_K_M"',
  'OPENROUTER_HOST: https://openrouter.ai/api/v1   # the endpoint',
  'OPENROUTER_API_KEY: sk-this-must-never-be-read',
  'GOOSE_MODE: "smart_approve"',
  '',
].join('\n');

function msg(db: DatabaseSync, id: string, role: string, ts: number, content: unknown): void {
  db.prepare('INSERT INTO messages (session_id, role, content_json, created_timestamp) VALUES (?,?,?,?)')
    .run(id, role, JSON.stringify(content), ts);
}

function usage(db: DatabaseSync, id: string, ts: number, model: string | null, cols: Record<string, number | string | null>): void {
  db.prepare(
    `INSERT INTO usage_ledger (session_id, created_timestamp, model, input_tokens, output_tokens,
       total_tokens, cache_read_tokens, cache_write_tokens, cost, cost_source, is_compaction)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, ts, model,
    Number(cols.input ?? 0), Number(cols.output ?? 0), Number(cols.total ?? 0),
    Number(cols.cache_read ?? 0), Number(cols.cache_write ?? 0),
    cols.cost == null ? null : Number(cols.cost),
    (cols.cost_source as string | null) ?? null, Number(cols.compaction ?? 0));
}

/** A whole Goose home: config.yaml plus a sessions.db with one real session. */
function makeGooseHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'nerfd-goose-'));
  mkdirSync(join(root, 'config'), { recursive: true });
  mkdirSync(join(root, 'data', 'sessions'), { recursive: true });
  writeFileSync(join(root, 'config', 'config.yaml'), CONFIG_YAML);

  const db = new DatabaseSync(join(root, 'data', 'sessions', 'sessions.db'));
  db.exec(SCHEMA);
  db.prepare(
    `INSERT INTO sessions (id, session_type, working_dir, created_at, updated_at, provider_name, model_config_json)
     VALUES (?,?,?,?,?,?,?)`,
  ).run('s1', 'user', '/Users/someone/secret-project', '2026-05-29 08:26:40', '2026-05-29 08:26:57',
    'openrouter', JSON.stringify({ model_name: 'qwen/qwen3-coder', temperature: 0.1, toolshim: false }));

  // A subagent session: real rows, must never reach the scorecard twice.
  db.prepare('INSERT INTO sessions (id, session_type, working_dir, created_at, updated_at, parent_session_id) VALUES (?,?,?,?,?,?)')
    .run('s2', 'subagent', '/Users/someone/secret-project', '2026-05-29 08:26:40', '2026-05-29 08:26:57', 's1');
  msg(db, 's2', 'user', T0, [{ type: 'text', text: 'sub work' }]);
  msg(db, 's2', 'assistant', T0 + 1, [{ type: 'text', text: 'done' }]);

  msg(db, 's1', 'user', T0, [{ type: 'text', text: 'add a test for the parser' }]);
  msg(db, 's1', 'assistant', T0 + 3, [
    { type: 'thinking', thinking: 'the parser lives in src/parse.ts', signature: '' },
    { type: 'text', text: 'Running the suite.' },
    { type: 'toolRequest', id: 't1', tool_call: { status: 'success', value: { name: 'developer__shell', arguments: { command: 'pnpm test' } } } },
  ]);
  msg(db, 's1', 'user', T0 + 4, [
    { type: 'toolResponse', id: 't1', tool_result: { status: 'success', value: { content: [{ type: 'text', text: '3 passing' }] } } },
  ]);
  // A tool call the provider could not emit as valid JSON.
  msg(db, 's1', 'assistant', T0 + 6, [
    { type: 'toolRequest', id: 't2', tool_call: { status: 'error', error: 'failed to parse arguments for developer__edit' } },
  ]);
  // Ctrl+C mid tool call: Goose writes this exact string.
  msg(db, 's1', 'user', T0 + 7, [
    { type: 'toolResponse', id: 't2', tool_result: { status: 'error', error: 'Interrupted by the user to make a correction' } },
  ]);
  msg(db, 's1', 'assistant', T0 + 9, [{ type: 'text', text: 'What should I do instead?' }]);
  msg(db, 's1', 'user', T0 + 10, [
    { type: 'toolResponse', id: 't3', tool_result: { status: 'error', error: 'HTTP 429 rate limit exceeded, retry later' } },
  ]);
  msg(db, 's1', 'assistant', T0 + 12, [{ type: 'error', error: 'upstream request timed out' }]);
  msg(db, 's1', 'user', T0 + 13, [{ type: 'text', text: 'try again' }]);
  msg(db, 's1', 'assistant', T0 + 17, [{ type: 'text', text: 'Done.' }]);

  usage(db, 's1', T0 + 3, 'qwen3-coder-fp8', { input: 100, output: 20, total: 120, cache_read: 5, cache_write: 10, cost: 0.01, cost_source: 'provider_reported' });
  usage(db, 's1', T0 + 9, 'auto-compact', { input: 50, output: 5, total: 55, cost: 0.001, cost_source: 'estimated', compaction: 1 });
  usage(db, 's1', T0 + 17, 'qwen3-coder-fp8', { input: 200, output: 40, total: 240, cache_read: 15, cost: 0.02, cost_source: 'provider_reported' });
  db.close();
  return root;
}

function withGooseHome<T>(fn: (root: string) => T): T {
  const root = makeGooseHome();
  const saved = { root: process.env.GOOSE_PATH_ROOT, p: process.env.GOOSE_PROVIDER, m: process.env.GOOSE_MODEL };
  process.env.GOOSE_PATH_ROOT = root;
  delete process.env.GOOSE_PROVIDER;
  delete process.env.GOOSE_MODEL;
  try {
    return fn(root);
  } finally {
    if (saved.root === undefined) delete process.env.GOOSE_PATH_ROOT; else process.env.GOOSE_PATH_ROOT = saved.root;
    if (saved.p !== undefined) process.env.GOOSE_PROVIDER = saved.p;
    if (saved.m !== undefined) process.env.GOOSE_MODEL = saved.m;
  }
}

const fakeSession = (id: string) => ({ id, tool: 'goose', transcript_path: null } as unknown as Session);

// ---------------------------------------------------------------- config ---

test('the yaml reader gets the provider block and refuses to hold a credential', () => {
  const y = parseSimpleYaml(CONFIG_YAML);
  assert.equal(y.active_provider, 'openrouter');
  assert.equal((y.providers as Record<string, Record<string, string>>).openrouter!.model, 'qwen/qwen3-coder');
  assert.equal((y.providers as Record<string, Record<string, string>>).ollama!.model, 'qwen3:30b-q4_K_M');
  // A trailing comment is not part of the value.
  assert.equal(y.OPENROUTER_HOST, 'https://openrouter.ai/api/v1');
  assert.equal(y.GOOSE_MODE, 'smart_approve');
  // The api key is skipped while parsing, so it never lands in a variable.
  assert.ok(!('OPENROUTER_API_KEY' in y));
  assert.ok(!JSON.stringify(y).includes('sk-this-must-never-be-read'));
});

test('base_url comes from the provider key, and a local runtime gets its default', () => {
  withGooseHome((root) => {
    const cfg = readGooseConfig(join(root, 'config', 'config.yaml'));
    assert.equal(cfg.provider, 'openrouter');
    assert.equal(cfg.model, 'qwen/qwen3-coder');
    assert.equal(cfg.baseUrl, 'https://openrouter.ai/api/v1');

    const local = join(root, 'config', 'ollama.yaml');
    writeFileSync(local, 'active_provider: ollama\nproviders:\n  ollama:\n    model: qwen3:30b-q4_K_M\n');
    const c2 = readGooseConfig(local);
    assert.equal(c2.provider, 'ollama');
    assert.equal(c2.model, 'qwen3:30b-q4_K_M');
    // Nothing overrode it, but "the local one" is still a distinct endpoint.
    assert.equal(c2.baseUrl, 'http://localhost:11434');
  });
});

// ---------------------------------------------------------------- ledger ---

test('the ledger reads usage_ledger for tokens, model and context-limit hits', () => {
  withGooseHome(() => {
    const f = gooseAdapter.ledger(fakeSession('s1'))!;
    assert.ok(f, 'ledger returned facts');

    // Cache writes are billed as input, so they are input here.
    assert.equal(f.tokens_in, 100 + 10 + 50 + 200);
    assert.equal(f.tokens_out, 20 + 5 + 40);
    assert.equal(f.tokens_cache_read, 5 + 15);

    // The last non-compaction row names the model that actually served the
    // session, not the bare name the config asked for.
    assert.equal(f.raw_model, 'qwen3-coder-fp8');
    assert.equal(f.declared_name, 'qwen/qwen3-coder');
    assert.equal(f.raw_provider, 'openrouter');
    assert.equal(f.base_url, 'https://openrouter.ai/api/v1');

    // One compaction row means the conversation outgrew the window once.
    assert.equal(f.context_limit_hits, 1);

    assert.equal(f.turns, 5);
    assert.deepEqual(f.latencies_ms, [3000, 4000]);
    assert.equal(f.interrupts, 1);
    assert.equal(f.tool_call_errors, 1);
    assert.equal(f.rate_limit_hits, 1);
    assert.equal(f.timeouts, 1);
    assert.equal(f.api_errors, 1);

    assert.equal(f.first_ts, new Date(T0 * 1000).toISOString());
    assert.equal(f.last_ts, new Date((T0 + 17) * 1000).toISOString());

    // Goose's own cost is kept with its provenance; the handler re-prices.
    assert.ok(Math.abs((f.ledger_cost_usd ?? 0) - 0.031) < 1e-9);
    assert.equal(f.ledger_cost_source, 'provider_reported');

    // Nothing in a session row is a plain semver, so nothing is claimed.
    assert.equal(f.tool_version, null);
  });
});

test('the ledger is null for a session Goose never heard of, and never writes', () => {
  withGooseHome((root) => {
    assert.equal(gooseAdapter.ledger(fakeSession('nope')), null);
    const db = new DatabaseSync(join(root, 'data', 'sessions', 'sessions.db'), { readOnly: true });
    const n = db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number };
    db.close();
    assert.equal(n.n, 2);
  });
});

// -------------------------------------------------------------- normalise ---

test('normalise maps Goose events onto the canonical vocabulary', () => {
  for (const event of ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'SessionEnd']) {
    const out = gooseAdapter.normalise({ event, session_id: 'g1' });
    assert.ok(out, event);
    assert.ok((CANONICAL_EVENTS as readonly string[]).includes(out!.hook_event_name), event);
  }
  // Real events that carry no outcome are not scored.
  for (const event of ['PreToolUse', 'PreToolUseResult', 'BeforeReadFile', 'BeforeShellExecution']) {
    assert.equal(gooseAdapter.normalise({ event, session_id: 'g1' }), null, event);
  }
  assert.equal(gooseAdapter.normalise({ event: 'Invented', session_id: 'g1' }), null);
  assert.equal(gooseAdapter.normalise(null), null);
  assert.equal(gooseAdapter.normalise('SessionStart'), null);
  assert.equal(gooseAdapter.normalise([{ event: 'Stop' }]), null);
});

test('normalise carries working_dir and the prompt across under the names the handler reads', () => {
  const out = gooseAdapter.normalise({
    event: 'UserPromptSubmit', session_id: 'g1',
    matcher_context: 'refactor the billing module',
    message: 'refactor the billing module',
  })!;
  assert.equal(out.hook_event_name, 'UserPromptSubmit');
  assert.equal(out.prompt, 'refactor the billing module');
  // matcher_context is a duplicate of the prompt; it does not survive.
  assert.equal(out.matcher_context, undefined);

  const tool = gooseAdapter.normalise({
    event: 'PostToolUse', session_id: 'g1', tool_name: 'developer__shell',
    tool_input: { command: 'pnpm test' }, working_dir: '/Users/someone/secret-project',
  })!;
  assert.equal(tool.cwd, '/Users/someone/secret-project');
});

test('Goose tool names become the canonical ones, and nothing else comes with them', () => {
  const shell = gooseAdapter.normalise({
    event: 'PostToolUse', session_id: 'g1', tool_name: 'developer__shell',
    tool_input: { command: 'pnpm test', timeout_secs: 300 },
  })!;
  assert.equal(shell.tool_name, 'Bash');
  assert.deepEqual(shell.tool_input, { command: 'pnpm test' });
  assert.equal(shell.tool_name_raw, 'developer__shell');

  // developer__write carries the entire file in `content`. It must not survive.
  const write = gooseAdapter.normalise({
    event: 'PostToolUse', session_id: 'g1', tool_name: 'developer__write',
    tool_input: { path: '/Users/someone/secret-project/src/billing.ts', content: 'export const RATE = 0.175;' },
  })!;
  assert.equal(write.tool_name, 'Edit');
  assert.deepEqual(write.tool_input, { file_path: '/Users/someone/secret-project/src/billing.ts' });
  assert.ok(!JSON.stringify(write.tool_input).includes('RATE'));

  // developer__edit carries the before and after text: also source code.
  const edit = gooseAdapter.normalise({
    event: 'PostToolUse', session_id: 'g1', tool_name: 'developer__edit',
    tool_input: { path: '/x/y.ts', before: 'const a = 1;', after: 'const a = 2;' },
  })!;
  assert.deepEqual(edit.tool_input, { file_path: '/x/y.ts' });

  // text_editor's `command` is an editor verb, not a shell command.
  const view = gooseAdapter.normalise({
    event: 'PostToolUse', session_id: 'g1', tool_name: 'developer__text_editor',
    tool_input: { command: 'view', path: '/x/y.ts' },
  })!;
  assert.equal(view.tool_name, 'Read');
  assert.deepEqual(view.tool_input, { file_path: '/x/y.ts' });
  const replace = gooseAdapter.normalise({
    event: 'PostToolUse', session_id: 'g1', tool_name: 'developer__text_editor',
    tool_input: { command: 'str_replace', path: '/x/y.ts', old_str: 'a', new_str: 'b' },
  })!;
  assert.equal(replace.tool_name, 'Edit');
  assert.deepEqual(replace.tool_input, { file_path: '/x/y.ts' });

  // An extension tool we know nothing about keeps its namespaced name.
  const other = gooseAdapter.normalise({
    event: 'PostToolUse', session_id: 'g1', tool_name: 'memory__remember_memory', tool_input: { category: 'x' },
  })!;
  assert.equal(other.tool_name, 'memory__remember_memory');
  assert.deepEqual(other.tool_input, {});
});

test('the file and shell events fold onto PostToolUse, and a non-zero exit is a failure', () => {
  const edit = gooseAdapter.normalise({
    event: 'AfterFileEdit', session_id: 'g1', matcher_context: '/x/y.rs',
    tool_name: 'developer__write', tool_input: { path: '/x/y.rs', content: 'fn main() {}' },
  })!;
  assert.equal(edit.hook_event_name, 'PostToolUse');
  assert.equal(edit.tool_name, 'Edit');
  assert.deepEqual(edit.tool_input, { file_path: '/x/y.rs' });

  // matcher_context is the only carrier when tool_input uses an unknown key.
  const edit2 = gooseAdapter.normalise({
    event: 'AfterFileEdit', session_id: 'g1', matcher_context: '/x/z.rs', tool_name: 'custom__mutate', tool_input: {},
  })!;
  assert.deepEqual(edit2.tool_input, { file_path: '/x/z.rs' });

  const shell = gooseAdapter.normalise({
    event: 'AfterShellExecution', session_id: 'g1', matcher_context: 'cargo test',
    tool_name: 'developer__shell', tool_input: { command: 'cargo test' },
  })!;
  assert.equal(shell.hook_event_name, 'PostToolUse');
  assert.equal(shell.tool_name, 'Bash');
  assert.deepEqual(shell.tool_input, { command: 'cargo test' });

  const failed = gooseAdapter.normalise({
    event: 'AfterShellExecution', session_id: 'g1', tool_name: 'developer__shell',
    tool_input: { command: 'cargo test' }, tool_output: { exit_code: 101 },
  })!;
  assert.equal(failed.hook_event_name, 'PostToolUseFailure');

  const ok = gooseAdapter.normalise({
    event: 'AfterShellExecution', session_id: 'g1', tool_name: 'developer__shell',
    tool_input: { command: 'cargo test' }, tool_output: { exit_code: 0 },
  })!;
  assert.equal(ok.hook_event_name, 'PostToolUse');
});

test('a failed tool call hands the handler something to classify', () => {
  const out = gooseAdapter.normalise({
    event: 'PostToolUseFailure', session_id: 'g1', tool_name: 'developer__shell',
    tool_input: { command: 'x' }, tool_output: { error: 'HTTP 429 too many requests' },
  })!;
  assert.equal(out.hook_event_name, 'PostToolUseFailure');
  assert.ok(JSON.stringify(out.error).includes('429'));
});

// --------------------------------------------------------------- backfill ---

test('backfill rebuilds user sessions and leaves subagent sessions alone', () => {
  withGooseHome(() => {
    const all = gooseAdapter.backfill!('2020-01-01T00:00:00.000Z');
    assert.equal(all.length, 1);
    const s = all[0]!;
    assert.equal(s.id, 's1');
    assert.equal(s.tool, 'goose');
    assert.equal(s.source, 'backfill');
    assert.equal(s.model, 'qwen3-coder-fp8');
    assert.equal(s.model_ref.raw_provider, 'openrouter');
    assert.equal(s.metrics.turns, 5);
    assert.equal(s.metrics.tokens_in, 360);
    assert.equal(s.metrics.context_limit_hits, 1);
    assert.equal(s.duration_s, 17);
    // Backfill never reaches `finalise`, so the behavioural signals are
    // computed on the way out. Counts only; the turns are dropped.
    assert.ok(s.signals, 'signals attached');
    assert.equal(typeof s.signals!.edit_tool_calls, 'number');
    assert.equal(s.metrics.interrupts, 1);

    // A backfilled Goose session has no transcript file and no working tree to
    // profile, and it must not invent either.
    assert.equal(s.transcript_path, null);
    assert.equal(s.cwd, null);
    assert.equal(s.first_prompt, null);
    assert.deepEqual(s.touched_files, []);
    // Nothing anywhere in the record points at the person's project.
    assert.ok(!JSON.stringify(s).includes('secret-project'));
    assert.ok(!JSON.stringify(s).includes('parser'));

    // Nothing ended after this instant, so nothing comes back.
    assert.deepEqual(gooseAdapter.backfill!(new Date(Date.now() + 86_400_000).toISOString()), []);
  });
});

// ------------------------------------------------------------------ turns ---

test('gooseTurns replays the conversation in order', () => {
  withGooseHome(() => {
    const turns = gooseTurns(fakeSession('s1'));
    assert.deepEqual(turns.map((t) => t.role), [
      'user',                 // add a test
      'assistant', 'tool',    // reply + the shell request it made
      'tool',                 // the shell result
      'assistant', 'tool',    // the malformed request
      'tool',                 // interrupted
      'assistant',            // what should I do instead?
      'tool',                 // rate-limited result
      'assistant',            // the error turn
      'user', 'assistant',    // try again / done
    ]);

    const first = turns[1]!;
    assert.equal(first.text, 'Running the suite.');
    assert.equal(first.model, 'qwen3-coder-fp8');
    assert.equal(first.output_tokens, 20);
    assert.ok((first.thinking_tokens ?? 0) > 0);
    assert.equal(first.ts, T0 * 1000 + 3000);

    assert.equal(turns[2]!.tool, 'developer__shell');
    assert.equal(turns[2]!.command, 'pnpm test');
    assert.equal(turns[2]!.ok, true);

    // The malformed tool call and the interruption both show up as such.
    assert.equal(turns[5]!.ok, false);
    assert.equal(turns[6]!.interrupted, true);
    // The turn that was actually cut short is the assistant turn that asked
    // for the tool, and that is the one the signals count.
    assert.equal(turns[4]!.role, 'assistant');
    assert.equal(turns[4]!.interrupted, true);

    assert.equal(turns[7]!.ends_with_question, true);
    assert.equal(turns[11]!.ends_with_question, false);

    assert.deepEqual(gooseTurns(fakeSession('nope')), []);
  });
});

// ---------------------------------------------------------------- install ---

test('install writes a valid Open Plugins plugin and never uses a "*" matcher', () => {
  withGooseHome((root) => {
    const written = installGoose();
    const hooksPath = join(root, '.agents', 'plugins', 'nerfd', 'hooks', 'hooks.json');
    assert.ok(written.includes(hooksPath));
    assert.ok(gooseHooksInstalled());

    const file = JSON.parse(readFileSync(hooksPath, 'utf8')) as { hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string; timeout?: number }> }>> };
    assert.deepEqual(Object.keys(file.hooks).sort(), [...GOOSE_EVENTS].sort());
    // AfterFileEdit and AfterShellExecution fire on top of PostToolUse for the
    // same call, so subscribing to them would double-count every edit.
    assert.ok(!('AfterFileEdit' in file.hooks));
    assert.ok(!('AfterShellExecution' in file.hooks));

    for (const [event, rules] of Object.entries(file.hooks)) {
      for (const rule of rules) {
        // The matcher is a regex, not a glob: "*" does not compile and Goose
        // silently drops the rule. Omitting it runs for every event.
        assert.equal(rule.matcher, undefined, event);
        assert.ok(!JSON.stringify(rule).includes('"*"'), event);
        for (const action of rule.hooks) {
          assert.equal(action.type, 'command');
          // One shell string; Goose runs it with `sh -c` and has no args array.
          assert.equal(typeof action.command, 'string');
          assert.ok(action.command.endsWith('hook goose >/dev/null 2>&1'), action.command);
          assert.ok(action.command.includes(process.execPath));
          assert.equal(typeof action.timeout, 'number');
        }
      }
    }
    assert.equal(file.hooks.SessionEnd![0]!.hooks[0]!.timeout, 30);

    const manifest = JSON.parse(readFileSync(join(root, '.agents', 'plugins', 'nerfd', 'plugin.json'), 'utf8')) as Record<string, string>;
    assert.equal(manifest.name, 'nerfd');
    assert.ok(manifest.version && manifest.description);
    // The /nerfd recipe ships with the plugin; wiring it up is the person's call.
    assert.ok(existsSync(join(root, '.agents', 'plugins', 'nerfd', 'recipes', 'nerfd.yaml')));
  });
});

test('install is idempotent, keeps hand-added rules, and uninstall takes only ours', () => {
  withGooseHome((root) => {
    const dir = join(root, '.agents', 'plugins', 'nerfd', 'hooks');
    mkdirSync(dir, { recursive: true });
    const foreign = { matcher: '^developer__shell$', hooks: [{ type: 'command', command: 'echo mine' }] };
    writeFileSync(join(dir, 'hooks.json'), JSON.stringify({ hooks: { PostToolUse: [foreign] } }));

    installGoose();
    installGoose();
    const after = JSON.parse(readFileSync(join(dir, 'hooks.json'), 'utf8')) as { hooks: Record<string, unknown[]> };
    // One of theirs, one of ours, not two of ours.
    assert.equal(after.hooks.PostToolUse!.length, 2);
    assert.deepEqual(after.hooks.PostToolUse![0], foreign);

    installGoose(true);
    const removed = JSON.parse(readFileSync(join(dir, 'hooks.json'), 'utf8')) as { hooks: Record<string, unknown[]> };
    assert.deepEqual(removed.hooks, { PostToolUse: [foreign] });
    assert.ok(!gooseHooksInstalled());

    // Another plugin in the shared ~/.agents/plugins directory is never read
    // and never written.
    const other = join(root, '.agents', 'plugins', 'hello-hooks');
    mkdirSync(join(other, 'hooks'), { recursive: true });
    const untouched = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'say hi' }] }] } });
    writeFileSync(join(other, 'hooks', 'hooks.json'), untouched);
    installGoose();
    installGoose(true);
    assert.equal(readFileSync(join(other, 'hooks', 'hooks.json'), 'utf8'), untouched);
  });
});

test('uninstall removes the plugin outright when nothing of anyone else is in it', () => {
  withGooseHome((root) => {
    installGoose();
    installGoose(true);
    assert.ok(!existsSync(join(root, '.agents', 'plugins', 'nerfd')));
  });
});

test('detect finds Goose by its config, its store, or its binary', () => {
  withGooseHome(() => {
    assert.equal(gooseAdapter.detect(), true);
  });
  const empty = mkdtempSync(join(tmpdir(), 'nerfd-goose-empty-'));
  const savedRoot = process.env.GOOSE_PATH_ROOT;
  const savedPath = process.env.PATH;
  process.env.GOOSE_PATH_ROOT = empty;
  process.env.PATH = empty;
  try {
    assert.equal(gooseAdapter.detect(), false);
    writeFileSync(join(empty, 'goose'), '#!/bin/sh\n');
    assert.equal(gooseAdapter.detect(), true);
  } finally {
    if (savedRoot === undefined) delete process.env.GOOSE_PATH_ROOT; else process.env.GOOSE_PATH_ROOT = savedRoot;
    process.env.PATH = savedPath;
  }
});
