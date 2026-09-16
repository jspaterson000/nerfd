// nerfd — OpenCode plugin. Zero dependencies, pure ESM, never throws.
//
// OpenCode has no shell hooks, so this is the event source: it turns the
// plugin bus into the same canonical JSON every other nerfd adapter emits and
// hands it to `nerfd hook opencode` on stdin, detached, fire and forget.
//
// It is installed by way of a tiny generated loader at
// ~/.config/opencode/plugins/nerfd.js which imports this file by absolute path
// and passes the interpreter and CLI path found at install time.
//
// Privacy: prompt text is passed through in memory so the CLI can classify the
// task locally. The CLI stores it only when NERFD_KEEP_PROMPTS=1. Nothing here
// writes to disk, opens a socket, or logs anything.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const IDLE_MS = 15 * 60 * 1000; // a session with no activity for this long is over
const MAX_ERR = 300;            // error text is classified, never stored; cap it anyway

// ---------------------------------------------------------------- paths

function configHome() {
  return process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
}

function dataHome() {
  return process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
}

/** The session store. Sent as transcript_path so the ledger can find it. */
export function opencodeDbPath() {
  return join(dataHome(), 'opencode', 'opencode.db');
}

// ---------------------------------------------------------------- config

/**
 * JSONC without a dependency: strip // and /* *\/ comments that are not inside
 * a string, then drop trailing commas.
 */
export function stripJsonc(text) {
  let out = '';
  let inStr = false, esc = false, line = false, block = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (line) { if (c === '\n') { line = false; out += c; } continue; }
    if (block) { if (c === '*' && n === '/') { block = false; i++; } continue; }
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && n === '/') { line = true; i++; continue; }
    if (c === '/' && n === '*') { block = true; i++; continue; }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

const SECRET_RE = /key|token|secret|password/i;

/**
 * Secrets are removed on the way in, so no later code path can read one.
 * Only leaves are dropped: a model id like `donkey-v2` is a map key, not a
 * credential, and removing it would lose the declared name we came for.
 */
export function stripSecrets(v) {
  if (Array.isArray(v)) return v.map(stripSecrets);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      const isBranch = val !== null && typeof val === 'object';
      if (!isBranch && SECRET_RE.test(k)) continue;
      out[k] = stripSecrets(val);
    }
    return out;
  }
  return v;
}

/** OpenCode's own `{env:VAR}` and `{file:...}` interpolation, env only. */
function expand(v) {
  if (typeof v !== 'string') return v;
  const m = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(v.trim());
  if (m) return process.env[m[1]] || null;
  return v;
}

function readConfigFile(path) {
  try {
    if (!path || !existsSync(path)) return null;
    const parsed = JSON.parse(stripJsonc(readFileSync(path, 'utf8')));
    return parsed && typeof parsed === 'object' ? stripSecrets(parsed) : null;
  } catch {
    return null;
  }
}

/** Global, then $OPENCODE_CONFIG, then the project config: last wins. */
export function loadOpencodeConfigs(directory) {
  const paths = [
    join(configHome(), 'opencode', 'opencode.json'),
    join(configHome(), 'opencode', 'opencode.jsonc'),
    process.env.OPENCODE_CONFIG || null,
  ];
  if (directory) {
    paths.push(join(directory, '.opencode', 'opencode.json'));
    paths.push(join(directory, '.opencode', 'opencode.jsonc'));
  }
  const out = [];
  for (const p of paths) {
    const c = readConfigFile(p);
    if (c) out.push(c);
  }
  return out;
}

/**
 * The only place a custom provider's quantisation is ever visible is the
 * human-readable `name` the user typed into their own config.
 */
export function lookupProvider(configs, providerID, modelID) {
  let base_url = null, declared_name = null, provider_name = null, npm = null;
  for (const cfg of configs) {
    const p = cfg && cfg.provider && cfg.provider[providerID];
    if (!p || typeof p !== 'object') continue;
    if (typeof p.name === 'string') provider_name = p.name;
    if (typeof p.npm === 'string') npm = p.npm;
    const url = p.options && expand(p.options.baseURL ?? p.options.baseUrl);
    if (typeof url === 'string' && url) base_url = url;
    const m = modelID && p.models && p.models[modelID];
    if (m && typeof m === 'object' && typeof m.name === 'string') declared_name = m.name;
  }
  return { base_url, declared_name, provider_name, npm };
}

// ---------------------------------------------------------------- transport

// The CLI reads, mutates and writes one session row per event, so two of them
// running at once lose each other's work. Events are queued and delivered one
// at a time; the queue runs in the background, so no hook ever waits on it.
let queue = Promise.resolve();

function deliver(opts, payload) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    try {
      const child = spawn(opts.node || process.execPath, [opts.cli, 'hook', 'opencode'], {
        detached: true,
        stdio: ['pipe', 'ignore', 'ignore'],
        env: process.env,
      });
      child.on('error', finish);
      child.on('exit', finish);
      if (child.stdin) {
        child.stdin.on('error', () => {});
        child.stdin.end(JSON.stringify(payload));
      }
      child.unref();
      // Detached and unreferenced: if OpenCode exits first the write still
      // completes, and a wedged child never holds the queue for long.
      const t = setTimeout(finish, 30000);
      if (typeof t.unref === 'function') t.unref();
    } catch {
      finish();
    }
  });
}

function send(opts, payload) {
  try {
    if (!opts.cli) return;
    queue = queue.then(() => deliver(opts, payload)).catch(() => {});
  } catch {
    // A telemetry plugin must never take the host down with it.
  }
}

function errName(e) {
  if (!e) return null;
  if (typeof e === 'string') return e.slice(0, 64);
  return typeof e.name === 'string' ? e.name : 'UnknownError';
}

function errText(e) {
  try {
    if (!e) return '';
    if (typeof e === 'string') return e.slice(0, MAX_ERR);
    const msg = e.data && typeof e.data.message === 'string' ? e.data.message : '';
    return `${errName(e)} ${msg}`.slice(0, MAX_ERR);
  } catch {
    return '';
  }
}

function textOf(parts) {
  try {
    return (parts || [])
      .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('\n');
  } catch {
    return '';
  }
}

/** Did the tool report a failure? OpenCode signals it several ways. */
export function toolFailed(output) {
  try {
    if (!output) return false;
    const m = output.metadata;
    if (m && typeof m === 'object') {
      if (m.error === true || typeof m.error === 'string') return true;
      if (m.interrupted === true) return true;
      if (typeof m.exit === 'number' && m.exit !== 0) return true;
      if (typeof m.exitCode === 'number' && m.exitCode !== 0) return true;
    }
    if (typeof output.title === 'string' && /^error\b/i.test(output.title)) return true;
    if (typeof output.output === 'string' && /^\s*(error|exception)\b/i.test(output.output)) return true;
    return false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- plugin

export function createNerfdPlugin(opts = {}) {
  const wire = {
    node: opts.node || process.env.NERFD_NODE || process.execPath,
    cli: opts.cli || process.env.NERFD_CLI || '',
  };

  return async function NerfdPlugin({ directory, worktree } = {}) {
    const cwd = directory || worktree || process.cwd();
    const dbPath = opencodeDbPath();
    let configs = [];
    try { configs = loadOpencodeConfigs(cwd); } catch { configs = []; }

    /** sessionID -> { model, provider, timer, cwd } */
    const open = new Map();

    const emit = (sessionID, event, extra) => {
      if (!sessionID) return;
      send(wire, {
        hook_event_name: event,
        session_id: sessionID,
        cwd: (open.get(sessionID) || {}).cwd || cwd,
        transcript_path: dbPath,
        source: 'opencode-plugin',
        ...(extra || {}),
      });
    };

    const touch = (sessionID) => {
      const st = open.get(sessionID);
      if (!st) return;
      if (st.timer) { try { clearTimeout(st.timer); } catch { /* ignore */ } }
      st.timer = setTimeout(() => {
        open.delete(sessionID);
        emit(sessionID, 'SessionEnd', { reason: 'idle' });
      }, IDLE_MS);
      if (typeof st.timer.unref === 'function') st.timer.unref();
    };

    /** Emit SessionStart exactly once per session, with whatever identity we have. */
    const start = (sessionID, info) => {
      if (!sessionID || open.has(sessionID)) return false;
      const providerID = (info && info.providerID) || null;
      const modelID = (info && info.modelID) || null;
      const dir = (info && info.directory) || cwd;
      open.set(sessionID, { model: modelID, provider: providerID, cwd: dir, timer: null });
      const ids = lookupProvider(configs, providerID, modelID);
      emit(sessionID, 'SessionStart', {
        model: modelID,
        provider: providerID,
        base_url: ids.base_url,
        declared_name: ids.declared_name,
        provider_name: ids.provider_name,
      });
      touch(sessionID);
      return true;
    };

    /** A model we did not know at SessionStart, or one the user switched to. */
    const noteModel = (sessionID, providerID, modelID) => {
      const st = open.get(sessionID);
      if (!st || !modelID) return;
      if (st.model == null) {
        st.model = modelID;
        st.provider = providerID || st.provider;
        return;
      }
      if (st.model !== modelID) {
        const from = st.model;
        st.model = modelID;
        st.provider = providerID || st.provider;
        const ids = lookupProvider(configs, st.provider, modelID);
        emit(sessionID, 'PostModelSwitch', {
          from_model: from, to_model: modelID, model: modelID, provider: st.provider,
          base_url: ids.base_url, declared_name: ids.declared_name,
        });
      }
    };

    const endAll = (reason) => {
      for (const [id, st] of [...open.entries()]) {
        if (st.timer) { try { clearTimeout(st.timer); } catch { /* ignore */ } }
        open.delete(id);
        emit(id, 'SessionEnd', { reason });
      }
    };

    return {
      async event({ event }) {
        try {
          if (!event || typeof event.type !== 'string') return;
          const p = event.properties || {};
          switch (event.type) {
            case 'session.created': {
              const info = p.info || {};
              if (info.parentID) return;     // a sub-agent, not a session of its own
              const m = info.model || {};
              start(info.id, { providerID: m.providerID, modelID: m.id || m.modelID, directory: info.directory });
              return;
            }
            case 'session.updated': {
              const info = p.info || {};
              if (!open.has(info.id)) return;
              const m = info.model || {};
              noteModel(info.id, m.providerID, m.id || m.modelID);
              touch(info.id);
              return;
            }
            case 'message.updated': {
              const info = p.info || {};
              if (info.role !== 'assistant' || !info.sessionID) return;
              noteModel(info.sessionID, info.providerID, info.modelID);
              touch(info.sessionID);
              if (info.error) {
                if (errName(info.error) === 'MessageAbortedError') emit(info.sessionID, 'Interrupt', {});
                else emit(info.sessionID, 'StopFailure', { error_type: errName(info.error), error: errText(info.error) });
              }
              return;
            }
            case 'session.compacted': {
              emit(p.sessionID, 'StopFailure', { error_type: 'ContextCompacted', error: 'context window compacted' });
              touch(p.sessionID);
              return;
            }
            case 'session.error': {
              const id = p.sessionID;
              if (!id) return;
              if (errName(p.error) === 'MessageAbortedError') emit(id, 'Interrupt', {});
              else emit(id, 'StopFailure', { error_type: errName(p.error), error: errText(p.error) });
              touch(id);
              return;
            }
            case 'session.interrupt': {
              emit(p.sessionID, 'Interrupt', {});
              touch(p.sessionID);
              return;
            }
            case 'session.idle': {
              const id = p.sessionID;
              if (!id) return;
              start(id, null);
              emit(id, 'Stop', {});
              touch(id);          // 15 minutes of quiet from here and the session is done
              return;
            }
            case 'session.deleted': {
              const info = p.info || {};
              const st = open.get(info.id);
              if (st && st.timer) { try { clearTimeout(st.timer); } catch { /* ignore */ } }
              if (open.delete(info.id)) emit(info.id, 'SessionEnd', { reason: 'deleted' });
              return;
            }
            default:
              return;
          }
        } catch {
          // ignore
        }
      },

      async 'chat.message'(input, output) {
        try {
          const id = input && input.sessionID;
          if (!id) return;
          const m = (input && input.model) || {};
          start(id, { providerID: m.providerID, modelID: m.modelID });
          noteModel(id, m.providerID, m.modelID);
          const prompt = textOf(output && output.parts);
          emit(id, 'UserPromptSubmit', {
            prompt,
            model: m.modelID || null,
            provider: m.providerID || null,
            agent: input.agent || null,
          });
          touch(id);
        } catch {
          // ignore
        }
      },

      async 'tool.execute.after'(input, output) {
        try {
          const id = input && input.sessionID;
          if (!id) return;
          start(id, null);
          const args = (input && input.args) || {};
          const tool_input = {};
          const fp = args.filePath ?? args.file_path ?? args.path ?? args.notebook_path;
          if (typeof fp === 'string' && fp) tool_input.file_path = fp;
          if (typeof args.command === 'string' && args.command) tool_input.command = args.command;
          const failed = toolFailed(output);
          emit(id, failed ? 'PostToolUseFailure' : 'PostToolUse', {
            tool_name: input.tool || null,
            tool_input,
            ...(failed
              ? { error: String((output && output.metadata && output.metadata.error) || (output && output.title) || '').slice(0, MAX_ERR) }
              : {}),
          });
          touch(id);
        } catch {
          // ignore
        }
      },

      async dispose() {
        try { endAll('dispose'); } catch { /* ignore */ }
      },
    };
  };
}

export const NerfdPlugin = createNerfdPlugin();
export default createNerfdPlugin;
