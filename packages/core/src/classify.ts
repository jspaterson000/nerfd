import { type Category, type Size } from './types.ts';

// A dumb keyword classifier is fine as a first guess. The user can override
// with `nerfd rate --cat`. What matters is that a category always exists.
const RULES: Array<[Category, RegExp, number]> = [
  ['debug',    /\b(bug|fix|broken|error|exception|crash|fails?|failing|not working|traceback|stack ?trace|regression|flaky)\b/i, 3],
  ['refactor', /\b(refactor|clean ?up|simplify|rename|extract|restructure|reorganis|reorganiz|dedupe|tidy)\b/i, 3],
  ['review',   /\b(review|audit|explain|walk me through|what does|how does this|security review|code review)\b/i, 3],
  ['ux',       /\b(ui|ux|css|tailwind|layout|design|style|styling|component|button|modal|responsive|font|color|colour|dark mode|animation|figma)\b/i, 2],
  ['strategy', /\b(strategy|roadmap|plan|prioriti|architecture|trade-?offs?|should we|options|approach|business|market|pricing|positioning|go-to-market)\b/i, 2],
  ['writing',  /\b(write|draft|readme|docs?|documentation|blog|copy|email|announcement|changelog|summar)\b/i, 1],
  ['research', /\b(research|compare|investigate|find out|look into|which (library|tool|framework)|best way to|alternatives)\b/i, 2],
  ['ops',      /\b(deploy|ci|cd|docker|kubernetes|k8s|terraform|nginx|systemd|cron|pipeline|github actions|release|migrate database|infra)\b/i, 2],
  ['code',     /\b(implement|add|build|create|feature|endpoint|function|class|script|migration|api|integrat|support for)\b/i, 1],
];

export function classifyPrompt(prompt: string | null | undefined): Category {
  if (!prompt) return 'other';
  return classifyTexts([prompt]);
}

/**
 * Classify a whole conversation from the person's side of it. The first
 * prompt says what the session was for, so it counts double; the next few
 * user turns refine it, because "fix the failing test" often only shows up on
 * turn three of a session that opened with "here is the repo". Up to eight
 * user turns are read, each cut at 2000 characters, and only the category
 * comes out: the texts are neither stored nor returned.
 *
 * This is what a backfilled session gets, and what `finalise` re-runs at
 * session end when the person has not set the category themselves.
 */
export function classifyTexts(texts: Array<string | null | undefined>): Category {
  const scores = new Map<Category, number>();
  let read = 0;
  for (const raw of texts) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    if (read >= 8) break;
    const text = raw.slice(0, 2000);
    const turnWeight = read === 0 ? 2 : 1;
    read++;
    for (const [cat, re, weight] of RULES) {
      const hits = text.match(new RegExp(re.source, re.flags + 'g'));
      if (hits) scores.set(cat, (scores.get(cat) ?? 0) + hits.length * weight * turnWeight);
    }
  }
  let best: Category = 'other';
  let bestScore = 0;
  for (const [cat, score] of scores) {
    if (score > bestScore) { best = cat; bestScore = score; }
  }
  return best;
}

/** Task size from effort actually spent. Cheap and honest. */
export function inferSize(durationS: number | null, toolCalls: number, edits: number): Size {
  const d = durationS ?? 0;
  if (d > 45 * 60 || toolCalls > 60 || edits > 15) return 'l';
  if (d > 10 * 60 || toolCalls > 12 || edits > 3) return 'm';
  return 's';
}
