// Behavioural signals: how much did the human have to fight the model?
//
// Errors and latency say what the harness did. They do not say whether the
// person got what they wanted. The AMD analysis of 6,852 Claude Code sessions
// (April 2026) found that on degraded weeks the *behaviour* moved long before
// anything looked broken: interrupts up 12x, edits without a prior read up
// from 6% to 34%, frustration markers up 68%, median thinking down 73%.
// Those markers are cheap to compute from a transcript that is already on
// disk, and they are the closest thing to "was this session any good" that
// does not require the user to type anything.
//
// PRIVACY. This module is the only place in the codebase that looks at prompt
// text in bulk, so the rule is absolute and mechanical:
//
//   * `computeSignals` takes text, returns integers. Nothing else.
//   * No string, path, command, token or fragment of a turn appears in the
//     returned `Signals`. Every field is a number, a null or a boolean.
//   * Nothing is written to disk, logged, or retained after the call returns.
//     File paths live in a local `Set` for the duration of one call, purely so
//     that "was this file read before it was edited" can be answered, and go
//     out of scope with everything else.
//   * No network calls, here or anywhere reachable from here.
//
// Everything below is a heuristic. The marker tables are exported so they can
// be read, argued with and changed in a pull request, and `SIGNAL_VERSION` is
// bumped whenever a detector changes so a public record can say which version
// produced its counts. See docs/SIGNALS.md for precision expectations.

/** Bump whenever a detector changes. Published alongside the counts. */
export const SIGNAL_VERSION = 1;

/** One transcript event, normalised by a per-tool adapter. */
export interface Turn {
  role: 'user' | 'assistant' | 'tool';
  ts: number;                   // epoch ms
  text?: string;                // user or assistant visible text; read, never stored
  tool?: string;                // tool name for role 'tool' (Bash, Edit, Read, Write, exec, ...)
  path?: string;                // file path for read/edit/write tools; read, never stored
  command?: string;             // shell command for shell tools; read, never stored
  ok?: boolean;                 // tool result succeeded
  interrupted?: boolean;        // user interrupted this assistant turn
  thinking_tokens?: number;
  output_tokens?: number;
  model?: string;               // if a switch happened mid-session
  ends_with_question?: boolean; // adapters may precompute; else derived from text
}

/** Counts only. This is the whole output surface. */
export interface Signals {
  corrections: number;
  reprompts: number;
  frustration: number;
  pushback: number;
  clarifications: number;
  edits_without_read: number;
  edit_tool_calls: number;
  retries: number;
  test_failures_before_pass: number | null;
  turns_to_first_success: number | null;
  steering_ratio: number | null;
  thinking_ratio: number | null;
  abandoned: boolean;
  user_turns: number;
  assistant_turns: number;
}

export interface SignalRates {
  correction_rate: number | null;
  reprompt_rate: number | null;
  frustration_rate: number | null;
  pushback_rate: number | null;
  clarification_rate: number | null;
  edit_without_read_rate: number | null;
  retry_rate: number | null;
}

// ---------------------------------------------------------------------------
// Marker table
// ---------------------------------------------------------------------------

export type SignalKind = 'correction' | 'frustration' | 'pushback';

export interface SignalMarker {
  /** Stable id, so a change to one detector is visible in a diff. */
  id: string;
  signal: SignalKind;
  /** A regex over the sanitised turn, or the sentinel for the shouting check. */
  test: RegExp | 'ALL_CAPS';
  /** If this also matches the turn, the marker is discarded. */
  suppress?: RegExp;
  /** Why it is here, and what it deliberately does not catch. */
  note: string;
}

/**
 * Every phrase detector in one reviewable table.
 *
 * Read it as: "this turn looks like X, unless it also looks like Y". The
 * suppressors exist because the obvious word lists are wrong more often than
 * they are right — "add undo support" is a feature request, "stop the server"
 * is an instruction, "don't forget to" is a reminder.
 *
 * Corrections and pushback are additionally gated on structure (see
 * MAX_REACTION_CHARS and `followsAssistant`); frustration is not, because
 * people vent at length.
 */
export const SIGNAL_MARKERS: readonly SignalMarker[] = [
  // --- corrections: the model did the wrong thing and is being told so ------
  {
    id: 'no_lead',
    signal: 'correction',
    test: /^\s*(?:no|nope|nah|negative)\b(?=[\s,.!:;-]|$)/i,
    suppress: /^\s*no\s+(?:problem|worries|rush|need|idea|thanks|thank)\b/i,
    note: 'Turn opens with a flat "no". Suppressed for "no problem" / "no idea" style openers.',
  },
  {
    id: 'no_clause',
    signal: 'correction',
    test: /\bno[,!.]?\s+(?:that|this|it|i|you|don'?t|dont|stop|wait|not)\b/i,
    note: '"no, that is not it" mid-sentence. The following word is required so bare "no X" nouns do not match.',
  },
  {
    id: 'thats_wrong',
    signal: 'correction',
    test: /\b(?:that'?s|this is|that is|it'?s|its|you'?re|youre)\s+(?:the\s+)?(?:wrong|incorrect|not right|not correct|backwards|the opposite)\b|\byou (?:got|did) (?:it|that|this) wrong\b/i,
    note: 'Explicit verdict on the last assistant turn.',
  },
  {
    id: 'not_what_i_asked',
    signal: 'correction',
    test: /\bnot what i (?:asked|wanted|want|said|meant)\b|\bthat'?s not (?:it|the point)\b/i,
    note: 'The strongest correction phrase there is, and almost never ambiguous.',
  },
  {
    id: 'revert',
    signal: 'correction',
    test: /\b(?:revert|roll\s?back|undo|put (?:it|that|them) back|take (?:it|that) out)\b/i,
    suppress: /\b(?:add|adding|implement|implementing|build|building|create|creating|need|needs|want|write|writing|design|support for|feature)\b[^.?!]{0,60}\b(?:undo|redo|revert|roll\s?back)\b|\b(?:undo|revert|rollback)[\s/-]*(?:support|button|feature|stack|history|functionality|command|action|endpoint|api|option|flow)\b/i,
    note: 'Suppressed when "undo"/"revert" is the subject of a feature request rather than an instruction about the last change.',
  },
  {
    id: 'you_didnt',
    signal: 'correction',
    test: /\byou (?:didn'?t|did not|never|failed to|forgot to|still haven'?t|haven'?t|were supposed to)\b/i,
    note: 'Second person plus a negated verb. Almost always a complaint about the previous turn.',
  },
  {
    id: 'i_said',
    signal: 'correction',
    test: /\bi (?:already |just )?(?:said|told you|asked (?:for|you)|meant)\b/i,
    note: 'Restating an instruction the model missed.',
  },
  {
    id: 'still_broken',
    signal: 'correction',
    test: /\bstill (?:broken|failing|fails|failing|doesn'?t work|does not work|not working|wrong|red|erroring|the same|there|happening)\b/i,
    note: 'The fix did not fix it.',
  },
  {
    id: 'again',
    signal: 'correction',
    test: /^\s*again\b|\b(?:you|it|that|this)\s+(?:\w+\s+){0,2}again\b|\b(?:same|another) (?:thing|error|problem|issue|failure)\b/i,
    suppress: /\b(?:try|run|rerun|re-?run|do|execute|check|read|look|test|build|deploy|push|start|restart|call|fetch|search|generate)\b[^.?!]{0,25}\bagain\b/i,
    note: '"you did it again". Deliberately gives up on "run it again", which is an ordinary instruction, so genuine "try again" corrections are missed.',
  },

  // --- pushback: stop doing what you are doing ------------------------------
  {
    id: 'stop',
    signal: 'pushback',
    test: /^\s*(?:ok(?:ay)?|hey|wait|no)?[,\s]*stop\s*[!.,]*\s*$|\bstop\s*!+|\b(?:please\s+)?stop\s+(?:doing|editing|changing|writing|making|modifying|touching|deleting|removing|refactoring|rewriting|adding|creating)\b|\bstop\s+(?:that|this|it)\b/i,
    suppress: /\bstop\s+(?:the|that|this|my|our|all|any)?\s*(?:server|service|container|daemon|process|job|watcher|build|dev\s?server|loop|timer|interval|animation|video|music|script|worker|queue|stream|recording|test|tests|spinner)\b/i,
    note: 'Bare or imperative "stop". Suppressed when "stop" takes a piece of infrastructure as its object.',
  },
  {
    id: 'dont',
    signal: 'pushback',
    test: /^\s*(?:no,?\s*)?don'?t\b\s*[!.,]*\s*$|\bno,?\s*don'?t\b|\b(?:don'?t|do not)\s+(?:do|touch|change|edit|delete|remove|modify|commit|push|run|add|refactor|rewrite|create|move|rename|install)\b/i,
    suppress: /\b(?:don'?t|do not)\s+(?:forget|worry|hesitate|mind|bother)\b/i,
    note: '"don\'t forget to" is a reminder, not a refusal, so it is suppressed explicitly as well as excluded by the verb list.',
  },
  {
    id: 'wait',
    signal: 'pushback',
    test: /^\s*wait\b(?=[\s,.!]|$)|\bwait\s*!+|\bwait,\s/i,
    suppress: /\bwait\s+(?:for|until|till|on)\b/i,
    note: '"wait, ..." interrupts. "wait for the build" does not.',
  },
  {
    id: 'hold_on',
    signal: 'pushback',
    test: /\bhold (?:on|up)\b|\bhang on\b/i,
    suppress: /\bhold on to\b/i,
    note: 'Conversational brake.',
  },
  {
    id: 'abort',
    signal: 'pushback',
    test: /^\s*(?:abort|cancel)\b[\s,.!]*$|\b(?:abort|cancel)\s+(?:that|this|it|the\s+(?:edit|change|run|task|operation|refactor))\b|\bnever\s?mind\b|\bforget (?:it|that)\b/i,
    note: 'Explicit abandonment of the action in flight.',
  },

  // --- frustration ---------------------------------------------------------
  {
    id: 'profanity',
    signal: 'frustration',
    test: /\b(?:fuck(?:ing|ed|er|s)?|shit(?:ty|e)?|bullshit|bs|damn(?:it|ed)?|goddamn|crap(?:py)?|arse(?:hole)?|asshole|bloody hell|pissed?\s+off|screw (?:this|it)|jesus(?: christ)?|christ|ffs|for fuck'?s sake)\b/i,
    note: 'Swearing at a terminal is the single most reliable frustration marker in the corpus, and the most likely to embarrass someone, which is why only the count leaves.',
  },
  {
    id: 'wtf',
    signal: 'frustration',
    test: /\b(?:wtf|wth|omfg|omg)\b/i,
    note: 'Initialisms, checked as whole words so they cannot hit inside an identifier.',
  },
  {
    id: 'seriously',
    signal: 'frustration',
    test: /\bseriously\b|\bare you (?:serious|kidding)\b/i,
    suppress: /\bseriously\s+(?:good|great|nice|fast|helpful|impressive|useful|better|cool)\b/i,
    note: 'Suppressed when "seriously" is an intensifier for praise.',
  },
  {
    id: 'groan',
    signal: 'frustration',
    test: /\b(?:ugh+|argh+|aargh+|grr+|sigh|facepalm|jfc|smh)\b/i,
    note: 'Groans. Short and unambiguous.',
  },
  {
    id: 'why_do_you_keep',
    signal: 'frustration',
    test: /\bwhy (?:do|does|did|are|is|would) (?:you|it|this|that)\s+(?:keep|always|still|insist|constantly|even)\b/i,
    note: 'Repetition complaint. The "keep/always/still" word is required so ordinary "why does this fail" questions do not match.',
  },
  {
    id: 'come_on',
    signal: 'frustration',
    test: /\b(?:come on|c'?mon)\b/i,
    suppress: /\bcome on (?:board|in|over|to)\b/i,
    note: 'Exasperation.',
  },
  {
    id: 'double_bang',
    signal: 'frustration',
    test: /!!/,
    note: 'Two or more exclamation marks in a row.',
  },
  {
    id: 'triple_question',
    signal: 'frustration',
    test: /\?\?\?/,
    note: 'Three or more question marks in a row. Two is common in ordinary typing, three is not.',
  },
  {
    id: 'all_caps',
    signal: 'frustration',
    test: 'ALL_CAPS',
    note: 'Two or more shouted words of three letters or more, ignoring the acronyms in ACRONYM_ALLOWLIST and anything containing a digit or underscore (constants, env vars).',
  },
] as const;

/**
 * All-caps words that are vocabulary, not shouting. Anything here is ignored
 * by the `all_caps` marker. It is deliberately generous: missing a shout is
 * cheaper than telling someone they were angry because they wrote "JSON".
 */
export const ACRONYM_ALLOWLIST: ReadonlySet<string> = new Set([
  'API', 'JSON', 'JSONL', 'YAML', 'TOML', 'XML', 'HTML', 'CSS', 'SCSS', 'SQL', 'HTTP', 'HTTPS',
  'URL', 'URI', 'URLS', 'CLI', 'GUI', 'TUI', 'IDE', 'SDK', 'MCP', 'LLM', 'CRUD', 'REST', 'RPC',
  'GRPC', 'JWT', 'CORS', 'CSRF', 'XSS', 'TLS', 'SSL', 'SSH', 'DNS', 'CDN', 'AWS', 'GCP', 'IAM',
  'EC2', 'S3', 'RDS', 'SQS', 'SNS', 'VPC', 'CPU', 'GPU', 'RAM', 'SSD', 'OS', 'UTC', 'ISO',
  'UUID', 'ORM', 'DOM', 'SVG', 'PNG', 'JPG', 'JPEG', 'GIF', 'PDF', 'CSV', 'TSV', 'ENV', 'CI',
  'CD', 'PR', 'PRS', 'TODO', 'FIXME', 'NOTE', 'WARN', 'INFO', 'DEBUG', 'ERROR', 'TRACE',
  'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'OK', 'NULL', 'TRUE', 'FALSE',
  'AND', 'OR', 'NOT', 'README', 'LICENSE', 'CHANGELOG', 'MIT', 'NPM', 'PNPM', 'NODE', 'TS',
  'JS', 'TSX', 'JSX', 'PY', 'GO', 'RS', 'UI', 'UX', 'DB', 'ID', 'IDS', 'IP', 'TCP', 'UDP',
  'FTP', 'SMTP', 'IMAP', 'RFC', 'ABI', 'ASCII', 'UTF', 'BOM', 'EOF', 'EOL', 'REPL', 'JIT',
  'AOT', 'WASM', 'ARM', 'X86', 'MB', 'GB', 'KB', 'TB', 'MS', 'NS', 'HTTPX', 'CTE', 'ETL',
  'LTS', 'SLA', 'SLO', 'KPI', 'PII', 'GDPR', 'OAUTH', 'SAML', 'LDAP', 'VPN', 'NAT', 'QPS',
  'RPS', 'TTL', 'WIP', 'MVP', 'POC', 'QA', 'AI', 'ML', 'NLP', 'OCR', 'CSP', 'SPA', 'SSR',
  'CSR', 'PWA', 'ARIA', 'WCAG', 'SEO',
]);

// ---------------------------------------------------------------------------
// Text handling. Nothing here retains anything.
// ---------------------------------------------------------------------------

/** Corrections and pushback only count in short reactions, not in essays. */
export const MAX_REACTION_CHARS = 400;

/** Token overlap at or above this counts as a restatement of the last prompt. */
export const REPROMPT_OVERLAP = 0.6;

/** Softer bar, used only when the two prompts are close in time with no tool work between. */
export const REPROMPT_OVERLAP_FAST = 0.4;

/** "Close in time" for the reprompt rule, in milliseconds. */
export const REPROMPT_WINDOW_MS = 3 * 60_000;

/** "Ended right after trouble" for the abandonment rule, in milliseconds. */
export const ABANDON_WINDOW_MS = 2 * 60_000;

/**
 * Remove the parts of a turn that are quoting something rather than saying it:
 * fenced code blocks, inline code spans, quoted lines and indented blocks.
 *
 * This is what stops a pasted stack trace containing "no such file" from
 * reading as a correction, or a diff containing `if (!ok) return;` from
 * reading as pushback. An unterminated fence swallows the rest of the turn,
 * which is the conservative direction: we would rather miss a marker than
 * invent one.
 */
export function stripQuotedAndCode(text: string): string {
  if (!text) return '';
  const out: string[] = [];
  let fence: string | null = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line);
    if (fence) {
      if (fenceMatch && line.trim().startsWith(fence)) fence = null;
      continue;
    }
    if (fenceMatch) { fence = fenceMatch[1]!.slice(0, 3); continue; }
    if (/^\s*>/.test(line)) continue;              // quoted reply
    if (/^(?: {4,}|\t)\S/.test(line)) continue;    // indented code block
    out.push(line);
  }
  return out
    .join('\n')
    .replace(/`[^`\n]*`/g, ' ')                    // inline code spans
    .replace(/https?:\/\/\S+/g, ' ');              // urls: not speech
}

/** Last non-empty line of a turn ends in a question mark. */
function endsWithQuestion(clean: string): boolean {
  const lines = clean.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line) continue;
    return line.endsWith('?');
  }
  return false;
}

const STOPWORDS: ReadonlySet<string> = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'to', 'of', 'in', 'on', 'for', 'with',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'it', 'its', 'this', 'that', 'these',
  'those', 'i', 'you', 'we', 'they', 'my', 'your', 'our', 'their', 'me', 'do', 'does', 'did',
  'can', 'could', 'should', 'would', 'will', 'just', 'so', 'not', 'no', 'yes', 'please',
  'thanks', 'at', 'by', 'as', 'from', 'up', 'down', 'out', 'about', 'into', 'over', 'after',
  'before', 'again', 'still', 'also', 'very', 'really', 'now', 'there', 'here', 'what', 'why',
  'how', 'when', 'where', 'who', 'all', 'any', 'some', 'more', 'less', 'than', 'too', 'ok',
]);

function contentTokens(clean: string): Set<string> {
  const out = new Set<string>();
  for (const tok of clean.toLowerCase().match(/[a-z0-9_]+/g) ?? []) {
    if (tok.length >= 2 && !STOPWORDS.has(tok)) out.add(tok);
  }
  return out;
}

/**
 * Overlap coefficient: shared tokens over the size of the smaller set. Chosen
 * over Jaccard because a reprompt is usually a *shorter* restatement of the
 * previous prompt, and Jaccard punishes that asymmetry.
 */
function overlap(a: Set<string>, b: Set<string>): number {
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  if (small.size === 0) return 0;
  let shared = 0;
  for (const tok of small) if (big.has(tok)) shared++;
  return shared / small.size;
}

/** Shouted words: >= 3 letters, not an allowlisted acronym, not a CONSTANT_NAME. */
function shoutedWords(clean: string): number {
  let count = 0;
  for (const word of clean.match(/\b[A-Z][A-Z0-9_]{2,}\b/g) ?? []) {
    if (/[0-9_]/.test(word)) continue;
    if (ACRONYM_ALLOWLIST.has(word)) continue;
    count++;
  }
  return count;
}

/** True when any marker for `kind` fires on the sanitised turn. */
export function hasMarker(clean: string, kind: SignalKind): boolean {
  return matchedMarkers(clean, kind).length > 0;
}

/** Which marker ids fire, for debugging and for the tests. Ids only, never text. */
export function matchedMarkers(clean: string, kind: SignalKind): string[] {
  const hits: string[] = [];
  for (const m of SIGNAL_MARKERS) {
    if (m.signal !== kind) continue;
    const fired = m.test === 'ALL_CAPS' ? shoutedWords(clean) >= 2 : m.test.test(clean);
    if (!fired) continue;
    if (m.suppress && m.suppress.test(clean)) continue;
    hits.push(m.id);
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Tool handling
// ---------------------------------------------------------------------------

// Checked in this order: a tool whose name says "edit" is an edit even if it
// also says "read" (str_replace_editor, notebook_edit_and_read, ...).
const EDIT_TOOL = /edit|write|patch|replace|create|update|insert|append|modif/i;
const READ_TOOL = /read|view|open|cat|grep|glob|search|list|^ls$/i;
const SHELL_TOOL = /bash|shell|exec|terminal|command|zsh|^sh$|^run$/i;

/** Shell utilities that mean "the human or the model looked at this file". */
const READ_COMMANDS = /^(?:cat|bat|less|more|head|tail|nl|wc|grep|rg|ag|ack|sed|awk|view|open|code|vim|vi|nvim|nano|emacs|diff|jq|column|strings|file|stat|ls|tree|fd|find|git)$/;

/** Commands that look like a test run. Deliberately broad across ecosystems. */
const TEST_COMMAND =
  /(?:^|[\s;|&(])(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test|node\s+--test|npx\s+(?:jest|vitest|mocha|ava|playwright|tap)|pytest|py\.test|jest|vitest|mocha|go\s+test|cargo\s+test|mvn\s+(?:[\w:.-]+\s+)*test|gradlew?\s+test|dotnet\s+test|rspec|phpunit|make\s+(?:test|check)|ctest|mix\s+test|swift\s+test|rake\s+test|tox|bun\s+test|deno\s+test|python3?\s+-m\s+(?:unittest|pytest))\b/i;

function normPath(p: string): string {
  let q = p.trim().replace(/^['"]|['"]$/g, '').replace(/\\/g, '/');
  while (q.startsWith('./')) q = q.slice(2);
  return q.replace(/\/+$/, '');
}

function baseName(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

function looksLikePath(token: string): boolean {
  const s = token.replace(/^['"]|['"]$/g, '');
  if (!s || s.startsWith('-')) return false;
  return s.includes('/') || /\.[A-Za-z0-9]{1,8}$/.test(s);
}

/** Path-like arguments of the read-ish segments of a shell command. */
function readPathsInCommand(command: string): string[] {
  const out: string[] = [];
  for (const segment of command.split(/[|;&]+/)) {
    const parts = segment.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) continue;
    let i = 0;
    while (i < parts.length && /^(?:sudo|env|time|nice|xargs|command)$/.test(parts[i]!)) i++;
    const cmd = (parts[i] ?? '').replace(/^.*\//, '');
    if (!READ_COMMANDS.test(cmd)) continue;
    for (const token of parts.slice(i + 1)) {
      if (token.startsWith('-')) continue;
      if (looksLikePath(token)) out.push(normPath(token));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The computation
// ---------------------------------------------------------------------------

export function emptySignals(): Signals {
  return {
    corrections: 0, reprompts: 0, frustration: 0, pushback: 0, clarifications: 0,
    edits_without_read: 0, edit_tool_calls: 0, retries: 0,
    test_failures_before_pass: null, turns_to_first_success: null,
    steering_ratio: null, thinking_ratio: null, abandoned: false,
    user_turns: 0, assistant_turns: 0,
  };
}

const round = (v: number, dp: number) => Math.round(v * 10 ** dp) / 10 ** dp;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Does turn `i` react to the model, i.e. is the nearest earlier speaker the assistant? */
function followsAssistant(turns: Turn[], i: number): boolean {
  for (let j = i - 1; j >= 0; j--) {
    if (turns[j]!.role === 'assistant') return true;
    if (turns[j]!.role === 'user') return false;
  }
  return false;
}

/**
 * Reduce a transcript to counts. Pure, synchronous, allocation-bounded, and
 * safe to call on a partial or malformed transcript: unknown fields are
 * skipped rather than guessed at.
 */
export function computeSignals(turns: Turn[]): Signals {
  const s = emptySignals();
  if (!Array.isArray(turns) || turns.length === 0) return s;

  // Sanitised text, one entry per turn. Local to this call.
  const clean = turns.map((t) => (typeof t.text === 'string' ? stripQuotedAndCode(t.text) : ''));
  const isCorrection = new Array<boolean>(turns.length).fill(false);
  const isFrustration = new Array<boolean>(turns.length).fill(false);
  const isToolError = new Array<boolean>(turns.length).fill(false);

  // --- pass 1: what the human said ----------------------------------------
  let userChars = 0;
  let lastUserIdx = -1;
  const userTurnIdx: number[] = [];

  for (let i = 0; i < turns.length; i++) {
    const t = turns[i]!;
    if (t.role !== 'user') continue;
    s.user_turns++;
    userTurnIdx.push(i);
    userChars += typeof t.text === 'string' ? t.text.trim().length : 0;

    const text = clean[i]!;
    const reacting = text.trim().length <= MAX_REACTION_CHARS && followsAssistant(turns, i);

    if (reacting && hasMarker(text, 'correction')) { s.corrections++; isCorrection[i] = true; }
    if (reacting && hasMarker(text, 'pushback')) s.pushback++;
    if (hasMarker(text, 'frustration')) { s.frustration++; isFrustration[i] = true; }

    // Reprompt: did this restate the previous prompt?
    if (lastUserIdx >= 0) {
      const a = contentTokens(clean[lastUserIdx]!);
      const b = contentTokens(text);
      if (a.size >= 3 && b.size >= 3) {
        const ov = overlap(a, b);
        let repeat = ov >= REPROMPT_OVERLAP;
        if (!repeat && ov >= REPROMPT_OVERLAP_FAST) {
          // "same intent, quickly, and the model did nothing in between."
          const prev = turns[lastUserIdx]!;
          const quick = finite(prev.ts) && finite(t.ts) && t.ts - prev.ts <= REPROMPT_WINDOW_MS;
          let toolWork = false;
          for (let j = lastUserIdx + 1; j < i; j++) if (turns[j]!.role === 'tool') { toolWork = true; break; }
          repeat = quick && !toolWork;
        }
        if (repeat) s.reprompts++;
      }
    }
    lastUserIdx = i;
  }

  // --- pass 2: what the model did -----------------------------------------
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i]!;
    if (t.role !== 'assistant') continue;
    s.assistant_turns++;
    if (t.interrupted === true) s.pushback++;

    // Clarification: it ended on a question and then did nothing.
    const asks = t.ends_with_question ?? endsWithQuestion(clean[i]!);
    if (asks) {
      let actedInstead = false;
      for (let j = i + 1; j < turns.length; j++) {
        if (turns[j]!.role === 'user') break;
        if (turns[j]!.role === 'tool') { actedInstead = true; break; }
      }
      if (!actedInstead) s.clarifications++;
    }
  }

  // --- pass 3: tools -------------------------------------------------------
  const readFull = new Set<string>();
  const readBase = new Set<string>();
  const markRead = (p: string) => { const n = normPath(p); if (!n) return; readFull.add(n); readBase.add(baseName(n)); };
  const lastResult = new Map<string, boolean | undefined>();

  let testRuns = 0;
  let failsBeforePass = 0;
  let firstPassIdx = -1;

  for (let i = 0; i < turns.length; i++) {
    const t = turns[i]!;
    if (t.role !== 'tool') continue;
    if (t.ok === false) isToolError[i] = true;

    const name = typeof t.tool === 'string' ? t.tool : '';
    const command = typeof t.command === 'string' ? t.command : '';

    if (command || (name && SHELL_TOOL.test(name) && !EDIT_TOOL.test(name))) {
      // Shell: reads, retries and test runs all come from the command text.
      for (const p of readPathsInCommand(command)) markRead(p);

      const key = command.replace(/\s+/g, ' ').trim();
      if (key) {
        if (lastResult.has(key) && lastResult.get(key) === false) s.retries++;
        lastResult.set(key, t.ok);
      }

      if (command && TEST_COMMAND.test(command)) {
        testRuns++;
        if (t.ok === false && firstPassIdx < 0) failsBeforePass++;
        else if (t.ok === true && firstPassIdx < 0) firstPassIdx = i;
      }
      continue;
    }

    if (name && EDIT_TOOL.test(name)) {
      s.edit_tool_calls++;
      const p = typeof t.path === 'string' ? normPath(t.path) : '';
      if (p) {
        // A basename match counts as a read, because adapters mix absolute
        // tool paths with relative shell paths. That under-counts rather than
        // over-counts, which is the direction we want for a public number.
        if (!readFull.has(p) && !readBase.has(baseName(p))) s.edits_without_read++;
        markRead(p); // having edited it, you have seen it
      }
      continue;
    }

    if (name && READ_TOOL.test(name) && typeof t.path === 'string') markRead(t.path);
  }

  s.test_failures_before_pass = testRuns > 0 ? failsBeforePass : null;
  s.turns_to_first_success = firstPassIdx >= 0 ? userTurnIdx.filter((idx) => idx < firstPassIdx).length : null;
  s.steering_ratio = s.edit_tool_calls > 0 ? round(userChars / s.edit_tool_calls, 1) : null;

  // --- pass 4: thinking ----------------------------------------------------
  let thinkSum = 0;
  let outSum = 0;
  let sawThinking = false;
  for (const t of turns) {
    if (finite(t.thinking_tokens)) { thinkSum += t.thinking_tokens; sawThinking = true; }
    if (finite(t.output_tokens)) outSum += t.output_tokens;
  }
  s.thinking_ratio = sawThinking && outSum > 0 ? round(thinkSum / outSum, 4) : null;

  // --- pass 5: abandonment -------------------------------------------------
  let lastFriction = -1;
  for (let i = 0; i < turns.length; i++) {
    if (isToolError[i] || isCorrection[i] || isFrustration[i]) lastFriction = i;
  }
  if (lastFriction >= 0) {
    let repliedAfter = false;
    for (let j = lastFriction + 1; j < turns.length; j++) if (turns[j]!.role === 'assistant') { repliedAfter = true; break; }
    const endTs = turns[turns.length - 1]!.ts;
    const frictionTs = turns[lastFriction]!.ts;
    s.abandoned = !repliedAfter && finite(endTs) && finite(frictionTs) && endTs - frictionTs <= ABANDON_WINDOW_MS;
  }

  return s;
}

/**
 * Counts are not comparable between a 5-turn session and a 200-turn one, so
 * everything published is a rate. Denominators: per user turn for the things
 * the human did, per assistant turn for clarifications, per edit for
 * edits-without-read. `retry_rate` is per user turn too, because `Signals`
 * carries no shell-command count; read it as "retries per prompt", not as a
 * share of commands.
 */
export function signalRates(s: Signals): SignalRates {
  const perUser = (n: number) => (s.user_turns > 0 ? round(n / s.user_turns, 4) : null);
  return {
    correction_rate: perUser(s.corrections),
    reprompt_rate: perUser(s.reprompts),
    frustration_rate: perUser(s.frustration),
    pushback_rate: perUser(s.pushback),
    clarification_rate: s.assistant_turns > 0 ? round(s.clarifications / s.assistant_turns, 4) : null,
    edit_without_read_rate: s.edit_tool_calls > 0 ? round(s.edits_without_read / s.edit_tool_calls, 4) : null,
    retry_rate: perUser(s.retries),
  };
}

/**
 * Always false, on purpose.
 *
 * The regexes above are a floor, not a ceiling: they miss sarcasm, terseness
 * and anything not in English. A small local model would do better. The shape
 * that would keep the zero-transcript promise intact:
 *
 *   1. Detect a runtime already on the machine (`GET http://127.0.0.1:11434/api/tags`
 *      for Ollama, or an OpenAI-compatible `/v1/models` on a user-configured
 *      localhost port). Loopback only, never a hosted endpoint, and only a
 *      host the user configured by hand.
 *   2. Send one user turn at a time with a fixed prompt asking for a single
 *      label from {neutral, correcting, frustrated, blocked} and nothing else.
 *   3. Keep the label, discard the turn, and store only the counts — exactly
 *      the same output surface as today, so nothing downstream changes.
 *   4. Gate it behind explicit opt-in (`nerfd signals --classifier ollama:<model>`),
 *      record the model id and a bumped SIGNAL_VERSION with the counts, and
 *      fall back to the regexes on any failure or timeout.
 *
 * Until someone builds and evaluates that against a hand-labelled sample, this
 * returns false and no network code exists in this package.
 */
export function localClassifierAvailable(): boolean {
  return false;
}
