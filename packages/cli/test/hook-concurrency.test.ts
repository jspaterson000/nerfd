import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Session } from '@nerfd/core';

// Claude Code runs hooks with `async: true` and OpenCode's plugin fires tool
// and message events in parallel, so several `nerfd hook` processes routinely
// do a read-modify-write of the same session row at the same moment. Without a
// lock held across the read and the write, the last writer wins and every
// sibling's increment is silently lost - the session shows one tool call when
// eight happened. This is the regression test for that: real processes, real
// contention, one counter.

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts');
const DELIVERIES = 8;

function deliver(home: string, body: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'hook', 'claude'], {
      env: { ...process.env, NERFD_HOME: home },
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let err = '';
    child.stderr.on('data', (c) => { err += String(c); });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`hook exited ${code}: ${err}`))));
    child.stdin.end(JSON.stringify(body));
  });
}

test('concurrent hook deliveries for one session serialise instead of clobbering', async () => {
  const home = mkdtempSync(join(tmpdir(), 'nerfd-hook-concurrency-'));
  try {
    await Promise.all(Array.from({ length: DELIVERIES }, (_, i) => deliver(home, {
      hook_event_name: 'PostToolUse',
      session_id: 'concurrent-1',
      cwd: home,
      tool_name: 'Bash',
      tool_input: { command: `echo ${i}` },
    })));

    const db = new DatabaseSync(join(home, 'local.db'));
    const rows = db.prepare('SELECT data FROM sessions').all() as Array<{ data: string }>;
    db.close();

    // A hook never fails its host tool, so a lost delivery shows up as a
    // swallowed line in hook.log rather than a non-zero exit. Print it.
    let hookLog = '';
    try { hookLog = readFileSync(join(home, 'hook.log'), 'utf8'); } catch { /* the happy path writes none */ }

    assert.equal(rows.length, 1, 'eight deliveries of one session id make one row');
    const s = JSON.parse(rows[0]!.data) as Session;
    assert.equal(s.id, 'concurrent-1');
    assert.equal(s.metrics.tool_calls, DELIVERIES, `every delivery counted; none overwrote a sibling. hook.log:\n${hookLog}`);
    assert.equal(hookLog, '', 'no delivery was dropped into the log');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
