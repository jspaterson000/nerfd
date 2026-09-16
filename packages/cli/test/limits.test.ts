import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIMIT_SCOPES, validateLimitWindows, type LimitWindow } from '@nerfd/core';
import { parseCodexRollout } from '../src/transcript.ts';
import { claudeLimitWindows } from '../src/limits/claude.ts';
import { countSampleFiles, pruneSamples } from '../src/limits/store.ts';
import { extractSamples } from '../src/limits/statusline.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'src', 'cli.ts');

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

function windowOf(ws: LimitWindow[], scope: string, windowMin: number | null, nth = 0): LimitWindow {
  const found = ws.filter((w) => w.scope === scope && w.window_min === windowMin);
  assert.ok(found[nth], `no ${scope}/${windowMin} window #${nth} in ${JSON.stringify(ws)}`);
  return found[nth]!;
}

test('a codex rollout with two limit ids yields one window per id, split at the reset', () => {
  const f = parseCodexRollout(join(HERE, 'fixtures', 'codex', 'limits-rollout.jsonl'));
  const ws = f.limit_windows;
  // codex/primary, plus the model-scoped id's 5h window twice (it reset
  // mid-session) and its weekly window once.
  assert.equal(ws.length, 4);

  const plan = windowOf(ws, 'primary', 10080);
  assert.equal(plan.samples, 2);
  assert.equal(plan.used_pct_start, 40);
  assert.equal(plan.used_pct_end, 44);
  // Cumulative counters differenced between the first and last reading.
  assert.deepEqual(plan.tokens, { total: 4400, uncached_in: 2700, out: 600, cached_in: 1300 });
  assert.equal(plan.resets_in_min_end, 4311);
  assert.equal(plan.reset_bucket, 497170);
  assert.equal(plan.wall_hit, true);            // the last reading reported the wall

  // The model-scoped id is never named, only scoped.
  const modelScoped = ws.filter((w) => w.scope === 'model');
  assert.equal(modelScoped.length, 3);
  const runA = windowOf(ws, 'model', 300, 0);
  const runB = windowOf(ws, 'model', 300, 1);
  assert.equal(runA.samples, 1);
  assert.equal(runA.used_pct_end, 10);
  assert.equal(runA.reset_bucket, 497100);
  assert.equal(runB.samples, 2);
  assert.equal(runB.used_pct_start, 3);         // the counter reset, so a new entry
  assert.equal(runB.used_pct_end, 9);
  assert.equal(runB.reset_bucket, 497105);
  assert.deepEqual(runB.tokens, { total: 2200, uncached_in: 1500, out: 300, cached_in: 500 });

  const weekly = windowOf(ws, 'model', 10080);
  assert.equal(weekly.samples, 3);
  assert.equal(weekly.used_pct_start, 5);
  assert.equal(weekly.used_pct_end, 7);

  // The wall is reported by the limit payload, not by error text.
  assert.equal(f.rate_limit_hits, 1);
  assert.equal(validateLimitWindows(ws), null);

  // Nothing identifying survives: no limit id, no limit name, no plan type.
  const json = JSON.stringify(ws);
  for (const leak of ['codex_spark', 'Spark', 'limit_id', 'plan_type', 'pro']) {
    assert.ok(!json.includes(leak), `leaked ${leak}`);
  }
});

// ---------------------------------------------------------------------------
// Claude Code: status-line samples joined with the transcript
// ---------------------------------------------------------------------------

function claudeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'nerfd-limits-'));
  mkdirSync(join(home, 'limits'), { recursive: true, mode: 0o700 });
  return home;
}

test('the claude ledger turns status-line samples into windows and prices them from the transcript', () => {
  const home = claudeHome();
  const id = 'a1b2c3d4-0000-4000-8000-000000000001';
  const t0 = Date.parse('2026-09-16T10:00:00Z');
  const resets = Math.round(t0 / 1000) + 3 * 3600;
  writeFileSync(join(home, 'limits', `${id}.jsonl`), [
    JSON.stringify({ ts: t0, scope: 'five_hour', used_pct: 20, resets_at: resets }),
    JSON.stringify({ ts: t0, scope: 'seven_day', used_pct: 4.5, resets_at: resets + 86400 }),
    JSON.stringify({ ts: t0 + 600_000, scope: 'five_hour', used_pct: 31, resets_at: resets + 20 }),
    JSON.stringify({ ts: t0 + 600_000, scope: 'spend', used_pct: 140, resets_at: null }),
    '{ not json',
  ].join('\n') + '\n');

  const transcript = join(home, 'transcript.jsonl');
  writeFileSync(transcript, [
    // Before the first sample: not this window's tokens.
    JSON.stringify({ type: 'assistant', timestamp: '2026-09-16T09:50:00Z', requestId: 'r0', message: { usage: { input_tokens: 999, output_tokens: 999 } } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-09-16T10:02:00Z', requestId: 'r1', message: { usage: { input_tokens: 100, cache_creation_input_tokens: 10, cache_read_input_tokens: 500, output_tokens: 40 } } }),
    // Same response, second line: the usage block repeats and must not double.
    JSON.stringify({ type: 'assistant', timestamp: '2026-09-16T10:02:01Z', requestId: 'r1', message: { usage: { input_tokens: 100, cache_creation_input_tokens: 10, cache_read_input_tokens: 500, output_tokens: 40 } } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-09-16T10:08:00Z', requestId: 'r2', isSidechain: true, message: { usage: { input_tokens: 700, output_tokens: 700 } } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-09-16T10:09:00Z', requestId: 'r3', message: { usage: { input_tokens: 200, cache_read_input_tokens: 100, output_tokens: 60 } } }),
  ].join('\n') + '\n');

  const ws = claudeLimitWindows(id, transcript, true, join(home, 'limits'));
  assert.equal(ws.length, 3);
  assert.equal(validateLimitWindows(ws), null);

  const five = ws.find((w) => w.scope === 'five_hour')!;
  assert.equal(five.window_min, 300);
  assert.equal(five.samples, 2);
  assert.equal(five.used_pct_start, 20);
  assert.equal(five.used_pct_end, 31);
  assert.equal(five.wall_hit, true);
  assert.equal(five.reset_bucket, Math.floor((resets + 20) / 3600));
  // 20 seconds of jitter is the same window, not a new one.
  assert.equal(five.resets_in_min_end, Math.round((resets + 20 - (t0 / 1000 + 600)) / 60));
  // r0 is before the window, r2 is a subagent, r1 is written twice.
  assert.deepEqual(five.tokens, { total: 1010, uncached_in: 310, out: 100, cached_in: 600 });

  const seven = ws.find((w) => w.scope === 'seven_day')!;
  assert.equal(seven.window_min, 10080);
  assert.equal(seven.samples, 1);

  const spend = ws.find((w) => w.scope === 'spend')!;
  assert.equal(spend.window_min, null);
  assert.equal(spend.used_pct_end, 140);        // a spend cap can pass 100
  assert.equal(spend.reset_bucket, null);
  assert.equal(validateLimitWindows([spend]), null);
});

test('no samples on file is an empty list, not a failure', () => {
  const home = claudeHome();
  assert.deepEqual(claudeLimitWindows('nothing-here', null, false, join(home, 'limits')), []);
  // A session id that is not one is refused rather than escaped.
  assert.deepEqual(claudeLimitWindows('../../etc/passwd', null, false, join(home, 'limits')), []);
});

// ---------------------------------------------------------------------------
// The status-line wrapper
// ---------------------------------------------------------------------------

const STATUS_JSON = {
  hook_event_name: 'Status',
  session_id: 'b1b2c3d4-0000-4000-8000-000000000002',
  transcript_path: '/Users/someone/.claude/projects/-Users-someone-secret/x.jsonl',
  cwd: '/Users/someone/secret-project',
  model: { id: 'claude-opus-5', display_name: 'Opus' },
  workspace: { current_dir: '/Users/someone/secret-project', project_dir: '/Users/someone/secret-project' },
  version: '2.1.0',
  cost: { total_cost_usd: 1.234, total_duration_ms: 90_000, total_lines_added: 42 },
  exceeds_200k_tokens: false,
  rate_limits: {
    five_hour: { used_percentage: 12.5, resets_at: 1789560000 },
    seven_day: { used_percentage: 3, resets_at: 1789984800 },
    spend_limit: { used_percentage: 0, resets_at: null },
  },
};

test('extraction names two fields of the status payload and nothing else', () => {
  const got = extractSamples(STATUS_JSON);
  assert.equal(got.session_id, STATUS_JSON.session_id);
  assert.deepEqual(got.readings.map((r) => r.scope), ['five_hour', 'seven_day', 'spend']);
  assert.equal(extractSamples({ session_id: '../../etc/passwd', rate_limits: {} }).session_id, null);
  assert.deepEqual(extractSamples(null).readings, []);
  assert.deepEqual(extractSamples({ session_id: 'x', rate_limits: { five_hour: { used_percentage: 'lots' } } }).readings, []);
});

function runWrapper(home: string, input: string): { stdout: Buffer; status: number | null } {
  const r = spawnSync(process.execPath, [CLI, 'statusline'], {
    input,
    env: { ...process.env, NERFD_HOME: home },
    timeout: 20_000,
  });
  return { stdout: Buffer.isBuffer(r.stdout) ? r.stdout : Buffer.from(String(r.stdout ?? '')), status: r.status };
}

function configWith(home: string, command: string): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.json'), JSON.stringify({
    install_id: 'test-install', server: 'http://localhost:8787', share: 'never', plans: {},
    created_at: new Date().toISOString(),
    statusline_original: { type: 'command', command },
  }, null, 2));
}

test('the wrapper samples two fields, passes the original through byte for byte, and prints nothing of its own', () => {
  const home = mkdtempSync(join(tmpdir(), 'nerfd-wrap-'));
  // `cat` returns its stdin unchanged, so a byte-identical answer proves both
  // that the child got the same stdin and that nothing was added to its stdout.
  configWith(home, 'cat');
  const input = JSON.stringify(STATUS_JSON);

  const first = runWrapper(home, input);
  assert.equal(first.status, 0);
  assert.equal(first.stdout.toString('utf8'), input);

  const file = join(home, 'limits', `${STATUS_JSON.session_id}.jsonl`);
  const rows = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), ['resets_at', 'scope', 'ts', 'used_pct']);
    assert.ok(LIMIT_SCOPES.includes(row.scope), row.scope);
  }
  assert.deepEqual(rows.map((r) => r.used_pct), [12.5, 3, 0]);

  // Nothing else from the payload is on disk, under any key or any spelling.
  const raw = readFileSync(file, 'utf8');
  for (const leak of ['secret-project', 'claude-opus-5', 'total_cost_usd', '1.234', '2.1.0', '.jsonl', 'workspace']) {
    assert.ok(!raw.includes(leak), `leaked ${leak}`);
  }

  // A second redraw inside the minute adds nothing: one sample per scope per minute.
  runWrapper(home, input);
  assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 3);
});

test('the wrapper prints nothing when there is no original, and never fails on junk', () => {
  const home = mkdtempSync(join(tmpdir(), 'nerfd-wrap2-'));
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.json'), JSON.stringify({
    install_id: 'test-install', server: 'http://localhost:8787', share: 'never', plans: {}, created_at: new Date().toISOString(),
  }));
  const bare = runWrapper(home, JSON.stringify(STATUS_JSON));
  assert.equal(bare.status, 0);
  assert.equal(bare.stdout.length, 0);

  // Junk on stdin is a redraw like any other: exit 0, say nothing.
  configWith(home, 'printf ok');
  const junk = runWrapper(home, 'not json at all');
  assert.equal(junk.status, 0);
  assert.equal(junk.stdout.toString('utf8'), 'ok');
});

test('nerfd check deletes sample files older than thirty days', () => {
  const home = mkdtempSync(join(tmpdir(), 'nerfd-prune-'));
  mkdirSync(join(home, 'limits'), { recursive: true });
  const old = join(home, 'limits', 'old-session.jsonl');
  const fresh = join(home, 'limits', 'fresh-session.jsonl');
  writeFileSync(old, '{}\n');
  writeFileSync(fresh, '{}\n');
  const longAgo = Date.now() / 1000 - 40 * 86400;
  utimesSync(old, longAgo, longAgo);

  const dir = join(home, 'limits');
  assert.equal(pruneSamples(Date.now(), 30, dir), 1);
  assert.equal(countSampleFiles(dir), 1);
});

// ---------------------------------------------------------------------------
// The validator
// ---------------------------------------------------------------------------

function goodWindow(): Record<string, unknown> {
  return {
    scope: 'primary', window_min: 10080, used_pct_start: 40, used_pct_end: 44, samples: 2,
    resets_in_min_end: 4311, reset_bucket: 497170, wall_hit: false,
    tokens: { total: 4400, uncached_in: 2700, out: 600, cached_in: 1300 },
  };
}

test('validate takes the enum and refuses anything else', () => {
  assert.equal(validateLimitWindows(undefined), null);
  assert.equal(validateLimitWindows([]), null);
  assert.equal(validateLimitWindows([goodWindow()]), null);
  for (const scope of LIMIT_SCOPES) assert.equal(validateLimitWindows([{ ...goodWindow(), scope }]), null);

  // A scope off the enum is the leak this rule exists to stop.
  assert.match(validateLimitWindows([{ ...goodWindow(), scope: 'codex_bengalfox' }])!, /scope must be one of/);
  assert.match(validateLimitWindows([{ ...goodWindow(), scope: null }])!, /scope must be one of/);
  // Any other string is a transcript leak by another name.
  assert.match(validateLimitWindows([{ ...goodWindow(), limit_name: 'GPT-5.3-Codex-Spark' }])!, /must not be a string/);
  assert.match(validateLimitWindows([{ ...goodWindow(), tokens: { total: 'lots', uncached_in: 0, out: 0, cached_in: 0 } }])!, /tokens\.total invalid/);

  assert.ok(validateLimitWindows('windows'));
  assert.ok(validateLimitWindows([null]));
  assert.ok(validateLimitWindows([{ ...goodWindow(), wall_hit: 'yes' }]));
  assert.ok(validateLimitWindows([{ ...goodWindow(), samples: -1 }]));
  assert.ok(validateLimitWindows([{ ...goodWindow(), samples: 2e6 }]));
  assert.ok(validateLimitWindows([{ ...goodWindow(), used_pct_end: 1001 }]));
  assert.equal(validateLimitWindows([{ ...goodWindow(), scope: 'spend', used_pct_end: 320 }]), null);
  assert.ok(validateLimitWindows([{ ...goodWindow(), window_min: 0 }]));
  assert.ok(validateLimitWindows([{ ...goodWindow(), reset_bucket: 497170.5 }]));
  assert.ok(validateLimitWindows([{ ...goodWindow(), tokens: { total: -1, uncached_in: 0, out: 0, cached_in: 0 } }]));
  assert.ok(validateLimitWindows([{ ...goodWindow(), tokens: undefined }]));
  assert.ok(validateLimitWindows(new Array(65).fill(goodWindow())));
});

// ---------------------------------------------------------------------------
// Install and remove
// ---------------------------------------------------------------------------

function runInit(home: string, ...args: string[]): void {
  const r = spawnSync(process.execPath, [CLI, 'init', '--claude', ...args], {
    env: { ...process.env, HOME: home, NERFD_HOME: join(home, '.nerfd') },
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(r.status, 0, r.stderr);
}

test('init wraps an existing status line and --remove puts it back exactly', () => {
  const home = mkdtempSync(join(tmpdir(), 'nerfd-init-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  const settingsPath = join(home, '.claude', 'settings.json');
  const original = { type: 'command', command: '~/bin/my-line.sh --fancy', padding: 0 };
  writeFileSync(settingsPath, JSON.stringify({ statusLine: original, model: 'opus' }));
  const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

  runInit(home);
  const wrapped = read(settingsPath);
  assert.ok(wrapped.statusLine.command.includes('statusline'), wrapped.statusLine.command);
  assert.equal(wrapped.statusLine.padding, 0);           // everything else is kept
  assert.equal(wrapped.model, 'opus');
  // The original is saved where the wrapper will look for it.
  assert.deepEqual(read(join(home, '.nerfd', 'config.json')).statusline_original, original);

  runInit(home, '--remove');
  const restored = read(settingsPath);
  assert.deepEqual(restored.statusLine, original);
  assert.equal(restored.model, 'opus');
  assert.equal(read(join(home, '.nerfd', 'config.json')).statusline_original, null);
});

test('with no status line and no pro/max plan, none is installed', () => {
  const home = mkdtempSync(join(tmpdir(), 'nerfd-init2-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  const settingsPath = join(home, '.claude', 'settings.json');
  writeFileSync(settingsPath, '{}');
  runInit(home);
  assert.equal(JSON.parse(readFileSync(settingsPath, 'utf8')).statusLine, undefined);
});
