// A minimal TOML reader, and a marker-delimited block appender.
//
// Two jobs, deliberately separated:
//
//   1. `parseToml` reads enough TOML to find what the adapter needs in Kimi
//      Code's `config.toml`: `default_model`, `[providers.<id>]` tables and
//      the `[[hooks]]` array. It is a reader only. Nothing here rewrites a
//      user's file from a parsed tree, because a round trip through an
//      incomplete parser is how other people's configuration gets destroyed.
//   2. `appendBlock` / `removeBlock` edit the file as *text*, between two
//      marker comments. Whatever else is in the file is bytes we never touch.
//
// Privacy: secrets are dropped during parsing, not after. A key that looks
// like a credential never enters the returned object, so no later bug can
// print, log or send one. See docs/PRIVACY.md, "never read tokens".

/** Keys whose values are dropped at parse time and never materialise. */
const SECRET_KEY_RE = /(^|_)(api[_-]?key|key|token|secret|password|passwd|credential|auth|bearer|access[_-]?token|refresh[_-]?token|client[_-]?secret|session[_-]?id)$/i;

export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
export interface TomlTable { [k: string]: TomlValue | undefined }

const REDACTED = '[redacted]';

// ---- scalars ------------------------------------------------------------

/** "a\nb", 'a\nb' (literal), or a bare token. Returns null when unparseable. */
function parseScalar(raw: string): TomlValue | null {
  const s = raw.trim();
  if (!s) return null;
  if (s.startsWith('"""') || s.startsWith("'''")) {
    // Multi-line strings are only ever prose in these files; keep the body.
    const q = s.slice(0, 3);
    const end = s.indexOf(q, 3);
    return end === -1 ? s.slice(3) : unescape(s.slice(3, end), q === '"""');
  }
  if (s.startsWith('"')) {
    const body = readQuoted(s, '"');
    return body == null ? null : unescape(body, true);
  }
  if (s.startsWith("'")) {
    const body = readQuoted(s, "'");
    return body == null ? null : body;
  }
  if (s.startsWith('[')) return parseArray(s);
  if (s.startsWith('{')) return parseInlineTable(s);
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^[+-]?(\d[\d_]*)$/.test(s)) return Number(s.replace(/_/g, ''));
  if (/^[+-]?(\d[\d_]*)?\.\d[\d_]*([eE][+-]?\d+)?$/.test(s) || /^[+-]?\d[\d_]*[eE][+-]?\d+$/.test(s)) return Number(s.replace(/_/g, ''));
  if (/^0x[0-9a-fA-F_]+$/.test(s)) return Number(s.replace(/_/g, ''));
  // Dates, times and anything else we do not model stay as their source text.
  return s;
}

/** The contents of a quoted string starting at index 0, honouring backslashes. */
function readQuoted(s: string, quote: '"' | "'"): string | null {
  let out = '';
  for (let i = 1; i < s.length; i++) {
    const c = s[i]!;
    if (quote === '"' && c === '\\') { out += c + (s[i + 1] ?? ''); i++; continue; }
    if (c === quote) return out;
    out += c;
  }
  return null;
}

function unescape(s: string, basic: boolean): string {
  if (!basic) return s;
  return s.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_m, e: string) => {
    if (e[0] === 'u' || e[0] === 'U') return String.fromCodePoint(parseInt(e.slice(1), 16));
    return { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', b: '\b', f: '\f' }[e] ?? e;
  });
}

/** Split on a delimiter at depth zero, ignoring anything inside quotes. */
function splitTop(body: string, delim: string): string[] {
  const out: string[] = [];
  let depth = 0, quote: string | null = null, cur = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (quote) {
      cur += c;
      if (c === '\\' && quote === '"') { cur += body[i + 1] ?? ''; i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '[' || c === '{') depth++;
    if (c === ']' || c === '}') depth--;
    if (c === delim && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function parseArray(s: string): TomlValue[] {
  const end = s.lastIndexOf(']');
  const body = s.slice(1, end === -1 ? undefined : end);
  return splitTop(body, ',').map((p) => parseScalar(p)).filter((v): v is TomlValue => v != null);
}

function parseInlineTable(s: string): TomlTable {
  const end = s.lastIndexOf('}');
  const body = s.slice(1, end === -1 ? undefined : end);
  const out: TomlTable = {};
  for (const part of splitTop(body, ',')) {
    const eq = indexOfTop(part, '=');
    if (eq === -1) continue;
    const key = splitKey(part.slice(0, eq));
    if (!key.length) continue;
    setPath(out, key, parseScalar(part.slice(eq + 1)));
  }
  return out;
}

/** Index of the first unquoted occurrence of `ch`. */
function indexOfTop(s: string, ch: string): number {
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === '\\' && quote === '"') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === ch) return i;
  }
  return -1;
}

/** `providers.kimi-for-coding` or `providers."kimi.eu"` -> path segments. */
function splitKey(raw: string): string[] {
  return splitTop(raw.trim(), '.')
    .map((p) => {
      const t = p.trim();
      if (t.startsWith('"') || t.startsWith("'")) {
        const body = readQuoted(t, t[0] as '"' | "'");
        return body == null ? '' : t[0] === '"' ? unescape(body, true) : body;
      }
      return t;
    })
    .filter((p) => p !== '');
}

function setPath(root: TomlTable, path: string[], value: TomlValue | null): void {
  if (value == null) return;
  const leaf = path[path.length - 1]!;
  const table = descend(root, path.slice(0, -1));
  if (!table) return;
  table[leaf] = SECRET_KEY_RE.test(leaf) ? REDACTED : value;
}

function descend(root: TomlTable, path: string[]): TomlTable | null {
  let cur: TomlTable = root;
  for (const seg of path) {
    let next = cur[seg];
    if (Array.isArray(next)) next = next[next.length - 1];
    if (next == null || typeof next !== 'object' || Array.isArray(next)) {
      const made: TomlTable = {};
      cur[seg] = made;
      cur = made;
    } else {
      cur = next as TomlTable;
    }
  }
  return cur;
}

// ---- document -----------------------------------------------------------

/**
 * Parse the subset of TOML these config files actually use: tables, arrays of
 * tables, dotted keys, strings, numbers, booleans, arrays and inline tables.
 * Never throws; a line it cannot read is skipped, and the rest still parses.
 */
export function parseToml(text: string): TomlTable {
  const root: TomlTable = {};
  let cur: TomlTable = root;
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (trimmed.startsWith('[[') ) {
      const end = trimmed.indexOf(']]');
      const path = splitKey(trimmed.slice(2, end === -1 ? undefined : end));
      if (!path.length) continue;
      const parent = descend(root, path.slice(0, -1));
      if (!parent) continue;
      const leaf = path[path.length - 1]!;
      const arr = Array.isArray(parent[leaf]) ? (parent[leaf] as TomlValue[]) : (parent[leaf] = []);
      const entry: TomlTable = {};
      arr.push(entry);
      cur = entry;
      continue;
    }
    if (trimmed.startsWith('[')) {
      const end = trimmed.indexOf(']');
      const path = splitKey(trimmed.slice(1, end === -1 ? undefined : end));
      if (!path.length) continue;
      cur = descend(root, path) ?? root;
      continue;
    }

    const eq = indexOfTop(line, '=');
    if (eq === -1) continue;
    const key = splitKey(line.slice(0, eq));
    if (!key.length) continue;
    let rhs = line.slice(eq + 1);
    // A multi-line string or array continues onto the following lines.
    const opener = rhs.trim().slice(0, 3);
    if (opener === '"""' || opener === "'''") {
      while (rhs.trim().length < 6 || rhs.indexOf(opener, rhs.indexOf(opener) + 3) === -1) {
        if (++i >= lines.length) break;
        rhs += '\n' + lines[i]!;
      }
    } else if (rhs.trim().startsWith('[') && indexOfTop(rhs, ']') === -1) {
      while (indexOfTop(rhs, ']') === -1 && ++i < lines.length) rhs += ' ' + lines[i]!;
    } else if (rhs.trim().startsWith('{') && indexOfTop(rhs, '}') === -1) {
      while (indexOfTop(rhs, '}') === -1 && ++i < lines.length) rhs += ' ' + lines[i]!;
    } else {
      rhs = stripComment(rhs);
    }
    setPath(cur, key, parseScalar(rhs));
  }
  return root;
}

/** Drop a trailing `# comment`, but only when the `#` is not inside a string. */
function stripComment(s: string): string {
  const at = indexOfTop(s, '#');
  return at === -1 ? s : s.slice(0, at);
}

// ---- typed getters ------------------------------------------------------

export function tableAt(root: TomlTable | null | undefined, ...path: string[]): TomlTable | null {
  let cur: TomlValue | undefined = root ?? undefined;
  for (const seg of path) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return null;
    cur = (cur as TomlTable)[seg];
  }
  return cur && typeof cur === 'object' && !Array.isArray(cur) ? (cur as TomlTable) : null;
}

export function stringAt(root: TomlTable | null | undefined, ...path: string[]): string | null {
  const leaf = path.pop()!;
  const t = tableAt(root, ...path);
  const v = t?.[leaf];
  return typeof v === 'string' && v !== REDACTED ? v : null;
}

export function arrayAt(root: TomlTable | null | undefined, ...path: string[]): TomlTable[] {
  const leaf = path.pop()!;
  const t = tableAt(root, ...path);
  const v = t?.[leaf];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is TomlTable => !!x && typeof x === 'object' && !Array.isArray(x));
}

// ---- marked block -------------------------------------------------------

export const BLOCK_START = '# >>> nerfd (managed block, do not edit) >>>';
export const BLOCK_END = '# <<< nerfd <<<';

/** The text with our block removed, exactly. Everything else is untouched. */
export function removeBlock(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let inside = false;
  for (const line of lines) {
    if (!inside && line.trimEnd() === BLOCK_START) { inside = true; continue; }
    if (inside) { if (line.trimEnd() === BLOCK_END) inside = false; continue; }
    out.push(line);
  }
  // An unterminated block means we already dropped the tail; that is correct.
  return out.join('\n').replace(/\n{3,}$/, '\n');
}

/** Replace our block, or append it. Any existing content is preserved verbatim. */
export function appendBlock(text: string, body: string): string {
  const base = removeBlock(text);
  const head = base.trim() ? base.replace(/\n*$/, '\n\n') : '';
  return `${head}${BLOCK_START}\n${body.replace(/\n*$/, '')}\n${BLOCK_END}\n`;
}

export function hasBlock(text: string): boolean {
  return text.split('\n').some((l) => l.trimEnd() === BLOCK_START);
}

/** A TOML basic string. Used only for values we generate (paths, event names). */
export function tomlString(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
}
