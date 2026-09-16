import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import '../src/quiet.ts';
import {
  crushAdapter, crushFacts, crushProjectFor, crushProjects, crushSessions, crushTurns,
  findCrushSession, installCrush,
} from '../src/adapters/crush.ts';

// The schema is the one Crush's own migrations produce (charmbracelet/crush,
// internal/db/migrations/*.sql), including the columns later migrations add,
// so the queries here are exercised against the real shape rather than a
// convenient one.
const SCHEMA = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  parent_session_id TEXT,
  title TEXT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0.0,
  updated_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  summary_message_id TEXT,
  todos TEXT
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  parts TEXT NOT NULL DEFAULT '[]',
  model TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER,
  provider TEXT,
  is_summary_message INTEGER DEFAULT 0 NOT NULL
);
`;

const T0 = Math.floor(Date.parse('2026-09-16T10:00:00Z') / 1000);
const SESSION = '5c6f1f7e-2c2d-4a8a-9a1a-0b6c1d2e3f40';

function buildDb(dir: string): string {
  const path = join(dir, 'crush.db');
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  db.prepare('INSERT INTO sessions (id, parent_session_id, title, message_count, prompt_tokens, completion_tokens, cost, updated_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(SESSION, null, 'Fix the billing bug in acme-payments', 6, 4200, 310, 0.031, T0 + 120, T0);
  // A sub-session: title generation. Crush hides these and so do we.
  db.prepare('INSERT INTO sessions (id, parent_session_id, title, message_count, prompt_tokens, completion_tokens, cost, updated_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('child-1', SESSION, 'title', 1, 10, 2, 0, T0 + 5, T0 + 5);

  const msg = db.prepare('INSERT INTO messages (id, session_id, role, parts, model, created_at, updated_at, finished_at, provider, is_summary_message) VALUES (?,?,?,?,?,?,?,?,?,?)');
  msg.run('m1', SESSION, 'user', JSON.stringify([{ type: 'text', data: { text: 'the tests fail on main' } }]), null, T0, T0, null, null, 0);
  msg.run('m2', SESSION, 'assistant', JSON.stringify([
    { type: 'text', data: { text: 'Shall I look at the failing test first?' } },
    { type: 'tool_call', data: { id: 'tc1', name: 'view', input: JSON.stringify({ file_path: '/Users/x/acme/src/pay.ts' }), finished: true } },
    { type: 'finish', data: { reason: 'tool_use', time: T0 + 4 } },
  ]), 'qwen3-coder', T0 + 4, T0 + 4, T0 + 5, 'openrouter', 0);
  msg.run('m3', SESSION, 'tool', JSON.stringify([
    { type: 'tool_result', data: { tool_call_id: 'tc1', name: 'view', content: 'InputValidationError: file_path is required', is_error: true } },
  ]), null, T0 + 6, T0 + 6, null, null, 0);
  msg.run('m4', SESSION, 'assistant', JSON.stringify([
    { type: 'text', data: { text: 'stopped' } },
    { type: 'finish', data: { reason: 'canceled', time: T0 + 60 } },
  ]), 'qwen3-coder', T0 + 60, T0 + 60, T0 + 60, 'openrouter', 0);
  // A summary message, which newer Crush writes and excludes from its own reads.
  msg.run('m5', SESSION, 'assistant', '[]', 'qwen3-coder', T0 + 61, T0 + 61, null, 'openrouter', 1);
  msg.run('m6', 'child-1', 'assistant', '[]', 'qwen3-coder', T0 + 5, T0 + 5, null, 'openrouter', 0);
  db.close();
  return path;
}

/** A machine with one Crush project, wired through the registry. */
function machine(): { home: string; project: string; db: string } {
  const home = mkdtempSync(join(tmpdir(), 'nerfd-crush-'));
  const project = join(home, 'acme');
  const dataDir = join(project, '.crush');
  mkdirSync(dataDir, { recursive: true });
  const db = buildDb(dataDir);
  const registryDir = join(home, 'share', 'crush');
  mkdirSync(registryDir, { recursive: true });
  writeFileSync(join(registryDir, 'projects.json'), JSON.stringify({
    projects: [{ path: project, data_dir: dataDir, last_accessed: '2026-09-16T10:02:00Z' }],
  }, null, 2));
  process.env.CRUSH_GLOBAL_DATA = registryDir;
  return { home, project, db };
}

test('the Crush registry resolves a project database from a working directory', () => {
  const m = machine();
  const projects = crushProjects();
  assert.equal(projects.length, 1);
  assert.equal(projects[0]!.db, m.db);
  assert.equal(crushProjectFor(join(m.project, 'src', 'deep'), projects)!.path, m.project);
  assert.equal(crushProjectFor('/somewhere/else', projects), null);
  // A registry that is missing or malformed is an empty list, never a throw.
  assert.deepEqual(crushProjects(join(m.home, 'nope.json')), []);
});

test('the Crush ledger reads session totals, cancels and malformed tool calls', () => {
  const m = machine();
  const db = new DatabaseSync(m.db, { readOnly: true });
  const row = findCrushSession(db, SESSION)!;
  const f = crushFacts(db, row);

  assert.equal(f.tokens_in, 4200);
  assert.equal(f.tokens_out, 310);
  assert.equal(f.turns, 2);                 // the summary message is not a turn
  assert.equal(f.model, 'qwen3-coder');
  assert.equal(f.raw_provider, 'openrouter');
  assert.equal(f.tool_call_errors, 1);
  assert.equal(f.interrupts, 1);
  assert.equal(f.first_ts, '2026-09-16T10:00:00.000Z');
  assert.ok(f.latencies_ms.length >= 1);

  // Sub-sessions are Crush's own bookkeeping, not sessions.
  assert.equal(crushSessions(db).length, 1);
  db.close();

  const ledger = crushAdapter.ledger({ id: SESSION, cwd: m.project, started_at: '2026-09-16T10:00:00Z' } as never)!;
  assert.equal(ledger.tokens_in, 4200);
  assert.equal(crushAdapter.ledger({ id: 'no-such-session', cwd: null, started_at: '2026-09-16T10:00:00Z' } as never), null);
});

test('Crush backfill creates one session per project database, and keeps nothing private', () => {
  machine();
  const sessions = crushAdapter.backfill!('2026-09-01T00:00:00Z');
  assert.equal(sessions.length, 1);
  const s = sessions[0]!;
  assert.equal(s.id, SESSION);
  assert.equal(s.tool, 'crush');
  assert.equal(s.source, 'backfill');
  assert.equal(s.metrics.tokens_in, 4200);
  assert.equal(s.model_ref.family, 'qwen3-coder');
  assert.equal(s.model_ref.provider, 'openrouter');

  // Nothing identifying: no title (the first prompt in disguise), no cwd, no
  // repo name, no paths.
  const json = JSON.stringify(s);
  assert.equal(s.cwd, null);
  assert.equal(s.first_prompt, null);
  assert.deepEqual(s.touched_files, []);
  assert.ok(!json.includes('billing'), 'session title must never be read');
  assert.ok(!json.includes('acme/src'), 'no file path may appear in a session');

  // A window that ends before the session leaves it out.
  assert.equal(crushAdapter.backfill!('2026-09-17T00:00:00Z').length, 0);
});

test('Crush turns carry text and tool outcomes for the signal detectors, and nothing to disk', () => {
  const m = machine();
  const turns = crushTurns({ id: SESSION, cwd: m.project, started_at: '2026-09-16T10:00:00Z' } as never);
  assert.deepEqual(turns.map((t) => t.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.equal(turns[1]!.ends_with_question, true);
  assert.equal(turns[1]!.model, 'qwen3-coder');
  assert.equal(turns[2]!.tool, 'view');
  assert.equal(turns[2]!.ok, false);
  assert.equal(turns[2]!.path, '/Users/x/acme/src/pay.ts');
  assert.equal(turns[3]!.interrupted, true);
});

test('the Crush hook installs in the flat shape Crush actually parses, and comes back out', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nerfd-crushcfg-'));
  const path = join(dir, 'crush.json');
  // A hand-written JSONC config with a comment and a hook of their own.
  writeFileSync(path, [
    '{',
    '  // my settings',
    '  "options": { "data_directory": ".crush" },',
    '  "hooks": { "PreToolUse": [{ "name": "no-rm", "matcher": "^bash$", "command": "./no-rm.sh" }] },',
    '}',
    '',
  ].join('\n'));

  installCrush(false, path);
  const after = JSON.parse(readFileSync(path, 'utf8'));
  const entries = after.hooks.PreToolUse;
  assert.equal(entries.length, 2);
  assert.equal(entries[0].name, 'no-rm');                 // theirs survives
  assert.equal(entries[1].name, 'nerfd');
  assert.ok(entries[1].command.includes('hook crush'));
  assert.ok(/^"/.test(entries[1].command), 'paths are quoted for the shell Crush runs hooks in');
  assert.equal(typeof entries[1].timeout, 'number');
  assert.deepEqual(after.options, { data_directory: '.crush' });

  installCrush(false, path);                               // idempotent
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).hooks.PreToolUse.length, 2);

  installCrush(true, path);
  const removed = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(removed.hooks.PreToolUse.length, 1);
  assert.equal(removed.hooks.PreToolUse[0].name, 'no-rm');
});

test('Crush normalise maps its one event onto the canonical vocabulary', () => {
  // Crush names the field `event`, and PreToolUse is all there is: it fires
  // before the call, so it counts attempts, never outcomes.
  assert.equal(crushAdapter.normalise({ event: 'PreToolUse', session_id: SESSION })!.hook_event_name, 'PostToolUse');
  const kept = crushAdapter.normalise({ event: 'PreToolUse', session_id: SESSION, tool_name: 'edit', tool_input: { file_path: '/x' }, cwd: '/p' })!;
  assert.equal(kept.tool_name, 'edit');
  assert.deepEqual(kept.tool_input, { file_path: '/x' });
  assert.equal(kept.cwd, '/p');
  assert.equal(crushAdapter.normalise({ event: 'SessionEnd', session_id: 's' }), null);
  assert.equal(crushAdapter.normalise({ hook_event_name: 'PostToolUse' }), null);
  assert.equal(crushAdapter.normalise(null), null);
  assert.equal(crushAdapter.normalise('PreToolUse'), null);
});
