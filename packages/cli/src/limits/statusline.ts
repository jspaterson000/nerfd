import { spawnSync } from 'node:child_process';
import { loadConfig, type Config } from '../paths.ts';
import { appendLine, readSamples, safeSessionId, type SampleScope } from './store.ts';

// `nerfd statusline` - the Claude Code status-line wrapper.
//
// Claude Code writes the status JSON to this process's stdin every time it
// redraws the status line, which is the only place window state appears on a
// Claude Code machine: the transcript carries none. This reads TWO fields out
// of it, `session_id` and `rate_limits`, appends at most one sample a minute
// per scope, then runs whatever status-line command the person had before and
// copies its output through byte for byte.
//
// The rules this file lives by, in order:
//
//  1. Never throw. A status line that errors is a broken status line, every
//     redraw, forever. Every step is wrapped; the worst case is that the
//     person's own status line still prints and nothing is sampled.
//  2. Never read anything else. `cwd`, `model`, `cost`, `workspace`,
//     `transcript_path`, `version` and the rest of the payload are not
//     referenced anywhere below, and the tests assert that nothing but the
//     two fields reaches the sample file.
//  3. Never delay. The wrapper does one small append and gives the original
//     command three seconds.

/** Status JSON key -> the scope it is stored under. Nothing else is read. */
const SCOPE_KEYS: ReadonlyArray<[string, SampleScope]> = [
  ['five_hour', 'five_hour'],
  ['seven_day', 'seven_day'],
  ['spend_limit', 'spend'],
];

/** One reading per scope per minute is plenty: a window is hours long. */
const MIN_SAMPLE_GAP_MS = 60_000;

/** The original status-line command gets the same budget Claude Code gives it. */
const CHILD_TIMEOUT_MS = 3000;

/** What Claude Code stores under `statusLine` in settings.json. */
export interface StatusLineSetting {
  type: string;
  command: string;
  padding?: number;
}

/**
 * paths.ts owns Config and is not ours to change, so the one key this feature
 * adds is declared by widening, the way plandetect declares `detected_plans`.
 */
export type ConfigWithStatusline = Config & { statusline_original?: StatusLineSetting | null };

export function withStatusline(cfg: Config): ConfigWithStatusline {
  return cfg as ConfigWithStatusline;
}

/** The original command, if `nerfd init` saved one. */
export function originalStatusLine(cfg: Config): StatusLineSetting | null {
  const s = withStatusline(cfg).statusline_original;
  if (!s || typeof s !== 'object') return null;
  return typeof s.command === 'string' && s.command.trim() ? s : null;
}

/** stdin, whole, as bytes. Bytes because they are handed to the child unchanged. */
async function readStdinBytes(timeoutMs = CHILD_TIMEOUT_MS): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const done = () => resolve(Buffer.concat(chunks));
    const timer = setTimeout(done, timeoutMs);
    timer.unref?.();
    const finish = () => { clearTimeout(timer); done(); };
    try {
      process.stdin.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
      process.stdin.on('end', finish);
      process.stdin.on('error', finish);
      process.stdin.on('close', finish);
    } catch {
      finish();
    }
  });
}

interface Reading { scope: SampleScope; used_pct: number; resets_at: number | null }

/**
 * The extraction, kept separate so a test can prove what it does and does not
 * touch. Input is the parsed status JSON; output is a session id and at most
 * three numbers per scope. No other key of the payload is named here.
 */
export function extractSamples(payload: unknown): { session_id: string | null; readings: Reading[] } {
  if (!payload || typeof payload !== 'object') return { session_id: null, readings: [] };
  const p = payload as Record<string, unknown>;
  const session_id = safeSessionId(p.session_id);
  const rl = p.rate_limits;
  const readings: Reading[] = [];
  if (rl && typeof rl === 'object' && !Array.isArray(rl)) {
    const r = rl as Record<string, unknown>;
    for (const [key, scope] of SCOPE_KEYS) {
      const w = r[key];
      if (!w || typeof w !== 'object') continue;
      const e = w as Record<string, unknown>;
      const used = e.used_percentage ?? e.used_percent;
      if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 1000) continue;
      const resets = e.resets_at;
      readings.push({
        scope,
        used_pct: used,
        resets_at: typeof resets === 'number' && Number.isFinite(resets) ? resets : null,
      });
    }
  }
  return { session_id, readings };
}

/** Scopes whose last reading is older than the gap, or that have none. */
function dueScopes(sessionId: string, readings: Reading[], now: number): Reading[] {
  const last = new Map<SampleScope, number>();
  for (const s of readSamples(sessionId).samples) {
    const prev = last.get(s.scope);
    if (prev == null || s.ts > prev) last.set(s.scope, s.ts);
  }
  return readings.filter((r) => {
    const t = last.get(r.scope);
    return t == null || now - t >= MIN_SAMPLE_GAP_MS || t > now + MIN_SAMPLE_GAP_MS;
  });
}

/** Append the readings that are due. Returns how many were written. */
export function recordSamples(payload: unknown, now = Date.now()): number {
  try {
    const { session_id, readings } = extractSamples(payload);
    if (!session_id || readings.length === 0) return 0;
    let n = 0;
    for (const r of dueScopes(session_id, readings, now)) {
      if (appendLine(session_id, { ts: now, scope: r.scope, used_pct: r.used_pct, resets_at: r.resets_at })) n++;
    }
    return n;
  } catch {
    return 0;
  }
}

/**
 * Run the status line the person actually configured, with the same stdin
 * bytes we were given, and return its stdout unchanged. A failure, a timeout
 * or a missing command all mean "print nothing": the wrapper has no output of
 * its own and never invents one.
 */
function runOriginal(cfg: Config, stdin: Buffer): Buffer | null {
  const original = originalStatusLine(cfg);
  if (!original) return null;
  try {
    const r = spawnSync(original.command, {
      shell: true,
      input: stdin,
      env: process.env,
      timeout: CHILD_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const out: unknown = r.stdout;
    if (out == null) return null;
    return Buffer.isBuffer(out) ? Buffer.from(out) : Buffer.from(String(out));
  } catch {
    return null;
  }
}

/** `nerfd statusline`. Reads stdin, samples, delegates. Never throws. */
export async function statusline(): Promise<void> {
  let raw: Buffer = Buffer.alloc(0);
  try {
    raw = await readStdinBytes();
  } catch { /* no stdin: still run the original */ }

  try {
    const text = raw.toString('utf8').trim();
    if (text) recordSamples(JSON.parse(text));
  } catch { /* not JSON, or the disk said no. Never the person's problem. */ }

  try {
    const out = runOriginal(loadConfig(), raw);
    if (out && out.length) process.stdout.write(out);
  } catch { /* the original is gone or unrunnable: print nothing */ }
}
