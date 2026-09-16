import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ABANDON_WINDOW_MS,
  SIGNAL_MARKERS,
  activeSeconds,
  SIGNAL_VERSION,
  computeSignals,
  emptySignals,
  localClassifierAvailable,
  matchedMarkers,
  signalRates,
  stripQuotedAndCode,
  type Turn,
} from '../src/signals.ts';

// --- fixture helpers -------------------------------------------------------
// A tiny clock so transcripts read in order without hand-written timestamps.

function clock(start = 1_760_000_000_000) {
  let t = start;
  const bump = (dtMs: number) => { t += dtMs; return t; };
  return {
    user: (text: string, dt = 30_000): Turn => ({ role: 'user', ts: bump(dt), text }),
    asst: (text: string, over: Partial<Turn> = {}, dt = 5_000): Turn => ({ role: 'assistant', ts: bump(dt), text, ...over }),
    tool: (over: Partial<Turn>, dt = 2_000): Turn => ({ role: 'tool', ts: bump(dt), ok: true, ...over }),
    bash: (command: string, ok = true, dt = 2_000): Turn => ({ role: 'tool', ts: bump(dt), tool: 'Bash', command, ok }),
    at: () => t,
  };
}

// The calm session: one prompt, one read, one edit, one thank-you. Every
// friction counter must be zero. If a detector ever fires here it is wrong.
function calmSession(): Turn[] {
  const c = clock();
  return [
    c.user('Add a health check endpoint to the server and cover it with a unit test.'),
    c.asst('Sure. I will read the router first, then add the route.'),
    c.tool({ tool: 'Read', path: '/repo/src/router.ts' }),
    c.tool({ tool: 'Edit', path: '/repo/src/router.ts' }),
    c.asst('Added the endpoint and a test alongside it.'),
    c.user('Great, thanks.'),
  ];
}

// ---------------------------------------------------------------------------

test('calm session produces all zeros', () => {
  const s = computeSignals(calmSession());
  assert.equal(s.corrections, 0);
  assert.equal(s.reprompts, 0);
  assert.equal(s.frustration, 0);
  assert.equal(s.pushback, 0);
  assert.equal(s.clarifications, 0);
  assert.equal(s.edits_without_read, 0);
  assert.equal(s.retries, 0);
  assert.equal(s.abandoned, false);
  assert.equal(s.test_failures_before_pass, null);
  assert.equal(s.turns_to_first_success, null);
  assert.equal(s.edit_tool_calls, 1);
  assert.equal(s.user_turns, 2);
  assert.equal(s.assistant_turns, 2);

  const r = signalRates(s);
  assert.equal(r.correction_rate, 0);
  assert.equal(r.frustration_rate, 0);
  assert.equal(r.edit_without_read_rate, 0);
});

test('empty and malformed input is safe', () => {
  assert.deepEqual(computeSignals([]), emptySignals());
  const s = computeSignals([
    { role: 'user', ts: Number.NaN },
    { role: 'assistant', ts: Number.NaN },
    { role: 'tool', ts: 0, tool: 'Edit' },
  ]);
  assert.equal(s.user_turns, 1);
  assert.equal(s.edit_tool_calls, 1);
  assert.equal(s.edits_without_read, 0); // no path: cannot judge, so not counted
  assert.equal(s.abandoned, false);
});

test('computeSignals returns nothing but numbers, booleans and nulls', () => {
  // The zero-transcript rule, enforced mechanically.
  const c = clock();
  const s = computeSignals([
    c.user('here is my secret prompt about project apollo'),
    c.asst('ok'),
    c.user("no, that's wrong, revert it"),
    c.tool({ tool: 'Edit', path: '/repo/secret/plans.ts' }),
    c.bash('grep -r apollo /repo', false),
  ]);
  for (const [k, v] of Object.entries(s)) {
    assert.ok(v === null || typeof v === 'number' || typeof v === 'boolean', `${k} leaked a ${typeof v}`);
  }
  assert.equal(JSON.stringify(s).includes('apollo'), false);
});

// --- corrections -----------------------------------------------------------

test('corrections fire on short reactions to the assistant', () => {
  const c = clock();
  const s = computeSignals([
    c.user('Rename the config loader.'),
    c.asst('Renamed it to loadSettings.'),
    c.user("no, that's not what I asked for"),
    c.asst('Sorry, reverting.'),
    c.user('revert that change'),
    c.asst('Done.'),
    c.user("you didn't run the tests"),
    c.asst('Running them now.'),
    c.user('it is still broken'),
    c.asst('Looking again.'),
    c.user('I said use the existing helper'),
    c.asst('Understood.'),
  ]);
  assert.equal(s.corrections, 5);
  assert.equal(signalRates(s).correction_rate, 0.8333); // rates round to 4dp
});

test('a correction inside a long essay is not counted', () => {
  const c = clock();
  const long = "no, that's wrong. " + 'x'.repeat(500);
  const s = computeSignals([c.user('start'), c.asst('done'), c.user(long)]);
  assert.equal(s.corrections, 0);
});

test('a correction before any assistant turn is not counted', () => {
  const c = clock();
  const s = computeSignals([c.user("no, that's wrong"), c.asst('ok')]);
  assert.equal(s.corrections, 0);
});

// --- reprompts -------------------------------------------------------------

test('reprompts detect a restated prompt by token overlap', () => {
  const c = clock();
  const s = computeSignals([
    c.user('Please add pagination to the users endpoint using cursor tokens.'),
    c.asst('Which page size should I use?'),
    c.user('Add cursor pagination to the users endpoint.', 20_000),
  ]);
  assert.equal(s.reprompts, 1);
});

test('a genuinely new prompt is not a reprompt', () => {
  const c = clock();
  const s = computeSignals([
    c.user('Please add pagination to the users endpoint using cursor tokens.'),
    c.asst('Done.'),
    c.tool({ tool: 'Edit', path: '/repo/users.ts' }),
    c.user('Now write the release notes for version three.'),
  ]);
  assert.equal(s.reprompts, 0);
});

test('a quick partial restatement with no tool work between counts', () => {
  // Half the words in common is below the overlap bar on its own, so this only
  // counts because it arrived seconds later with the model doing nothing.
  const first = 'Make the sidebar collapse on mobile widths please.';
  const second = 'The sidebar should collapse when the window is narrow.';

  const c = clock();
  assert.equal(computeSignals([c.user(first), c.user(second, 15_000)]).reprompts, 1);

  const d = clock();
  assert.equal(computeSignals([d.user(first), d.user(second, 20 * 60_000)]).reprompts, 0);

  // A near-verbatim restatement counts however long the pause was.
  const e = clock();
  assert.equal(computeSignals([
    e.user(first),
    e.user('Make the sidebar collapse on mobile.', 20 * 60_000),
  ]).reprompts, 1);
});

// --- frustration -----------------------------------------------------------

test('frustration markers fire once per turn', () => {
  const c = clock();
  const s = computeSignals([
    c.user('build the thing'),
    c.asst('built'),
    c.user('WHY DOES THIS KEEP HAPPENING???'),
    c.asst('sorry'),
    c.user('ugh'),
    c.asst('sorry'),
    c.user('seriously, come on'),
    c.asst('sorry'),
    c.user('this is broken!!'),
  ]);
  assert.equal(s.frustration, 4);
});

test('acronyms are not shouting and praise is not sarcasm', () => {
  const c = clock();
  const s = computeSignals([
    c.user('start'),
    c.asst('done'),
    c.user('the API returns JSON but the URL in the CLI config points at HTTP not HTTPS'),
    c.asst('fixing'),
    c.user('that was seriously good, thanks'),
  ]);
  assert.equal(s.frustration, 0);
});

// --- pushback --------------------------------------------------------------

test('pushback counts refusals and interrupted assistant turns', () => {
  const c = clock();
  const s = computeSignals([
    c.user('refactor the parser'),
    c.asst('Rewriting the whole module...', { interrupted: true }),
    c.user('stop'),
    c.asst('Stopped.'),
    c.user("wait, don't delete that file"),
    c.asst('Ok.'),
    c.user('hold on'),
    c.asst('Ok.'),
    c.user('cancel that'),
  ]);
  assert.equal(s.pushback, 5); // 1 interrupt + 4 refusals
});

// --- clarifications --------------------------------------------------------

test('clarifications are questions the assistant asks instead of acting', () => {
  const c = clock();
  const s = computeSignals([
    c.user('set up the database'),
    c.asst('Which database should I use, postgres or sqlite?'),
    c.user('postgres'),
    c.asst('Right. Should I use the docker image?'),
    c.tool({ tool: 'Bash', command: 'docker pull postgres:16' }),
    c.asst('Pulled it.'),
  ]);
  assert.equal(s.clarifications, 1);
  assert.equal(signalRates(s).clarification_rate, 0.3333);
});

test('a precomputed ends_with_question flag wins over the text', () => {
  const c = clock();
  const s = computeSignals([
    c.user('go'),
    c.asst('I could do A or B.', { ends_with_question: true }),
    c.user('A'),
  ]);
  assert.equal(s.clarifications, 1);
});

// --- edits without read ----------------------------------------------------

test('edits without read', () => {
  const c = clock();
  const s = computeSignals([
    c.user('patch three files'),
    c.asst('ok'),
    c.tool({ tool: 'Read', path: '/repo/src/a.ts' }),
    c.tool({ tool: 'Edit', path: '/repo/src/a.ts' }),      // read first: fine
    c.tool({ tool: 'Write', path: '/repo/src/b.ts' }),     // never seen: counts
    c.bash('cat src/c.ts'),
    c.tool({ tool: 'Edit', path: '/repo/src/c.ts' }),      // seen via shell: fine
    c.tool({ tool: 'Edit', path: '/repo/src/b.ts' }),      // second edit of b: already known
  ]);
  assert.equal(s.edit_tool_calls, 4);
  assert.equal(s.edits_without_read, 1);
  assert.equal(signalRates(s).edit_without_read_rate, 0.25);
});

test('grep and a relative path both count as having seen the file', () => {
  const c = clock();
  const s = computeSignals([
    c.user('fix it'),
    c.asst('ok'),
    c.bash('grep -n TODO packages/core/src/pricing.ts'),
    c.tool({ tool: 'Edit', path: './packages/core/src/pricing.ts' }),
  ]);
  assert.equal(s.edits_without_read, 0);
});

// --- retries ---------------------------------------------------------------

test('a repeat after a failure is a retry, a repeat after a success is not', () => {
  const c = clock();
  const s = computeSignals([
    c.user('build it'),
    c.asst('ok'),
    c.bash('npm run build', false),
    c.bash('npm  run   build', true),   // whitespace-normalised repeat of a failure
    c.bash('git status', true),
    c.bash('git status', true),         // repeat after success: not a retry
  ]);
  assert.equal(s.retries, 1);
});

// --- tests and first success ----------------------------------------------

test('test failures before the first pass, and prompts to get there', () => {
  const c = clock();
  const s = computeSignals([
    c.user('make the suite green'),
    c.bash('npm test', false),
    c.user('try the fixture from the other file'),
    c.bash('npm test', false),
    c.bash('npm test', true),
    c.asst('All green.'),
  ]);
  assert.equal(s.test_failures_before_pass, 2);
  assert.equal(s.turns_to_first_success, 2);
});

test('failures after the first pass do not count', () => {
  const c = clock();
  const s = computeSignals([
    c.user('run the suite'),
    c.bash('pytest -q', true),
    c.bash('pytest -q', false),
  ]);
  assert.equal(s.test_failures_before_pass, 0);
  assert.equal(s.turns_to_first_success, 1);
});

test('no test run at all leaves both null', () => {
  const c = clock();
  const s = computeSignals([c.user('hi'), c.bash('ls -la', true)]);
  assert.equal(s.test_failures_before_pass, null);
  assert.equal(s.turns_to_first_success, null);
});

// --- ratios ----------------------------------------------------------------

test('steering and thinking ratios', () => {
  const c = clock();
  const s = computeSignals([
    c.user('a'.repeat(100)),
    c.asst('ok', { thinking_tokens: 300, output_tokens: 100 }),
    c.tool({ tool: 'Edit', path: '/repo/x.ts' }),
    c.tool({ tool: 'Edit', path: '/repo/y.ts' }),
  ]);
  assert.equal(s.steering_ratio, 50);
  assert.equal(s.thinking_ratio, 3);

  const noEdits = computeSignals([{ role: 'user', ts: 1, text: 'hello there' }]);
  assert.equal(noEdits.steering_ratio, null);
  assert.equal(noEdits.thinking_ratio, null);
});

// --- abandonment -----------------------------------------------------------

test('a session that stops right after frustration is abandoned', () => {
  const c = clock();
  const s = computeSignals([
    c.user('fix the build'),
    c.asst('trying'),
    c.bash('npm run build', false),
    c.user('ugh, forget it', 20_000),
  ]);
  assert.equal(s.abandoned, true);
});

test('a session that recovers, or drifts on, is not abandoned', () => {
  const c = clock();
  const recovered = computeSignals([
    c.user('fix the build'),
    c.bash('npm run build', false),
    c.asst('Fixed the import.'),
    c.user('thanks'),
  ]);
  assert.equal(recovered.abandoned, false);

  const d = clock();
  const drifted = computeSignals([
    d.user('fix the build'),
    d.bash('npm run build', false),
    d.user('ok I will look at it myself later', ABANDON_WINDOW_MS + 60_000),
  ]);
  assert.equal(drifted.abandoned, false);
});

// --- false positives -------------------------------------------------------

test('false positives: code blocks, quoted lines and instruction verbs', () => {
  const c = clock();
  const withCode = [
    'here is the current file',
    '```ts',
    "if (!ok) return; // no, this is wrong, you didn't check",
    '```',
    '> no, that is not what I asked',
    'anything worth changing here?',
  ].join('\n');

  const turns: Turn[] = [
    c.user('look at this'),
    c.asst('sure'),
    c.user(withCode),                                   // markers only inside code and quotes
    c.asst('looks fine'),
    c.user('stop the server and restart it on port 8788'),  // an instruction, not a refusal
    c.asst('ok'),
    c.user('add undo support to the editor'),               // a feature request, not a revert
    c.asst('ok'),
    c.user("don't forget to update the changelog"),         // a reminder, not a refusal
    c.asst('ok'),
    c.user('run the tests again'),                          // an instruction, not a complaint
    c.asst('ok'),
    c.user('no problem, carry on'),                         // an idiom, not a rejection
    c.asst('ok'),
  ];
  const s = computeSignals(turns);
  assert.equal(s.corrections, 0);
  assert.equal(s.pushback, 0);
  assert.equal(s.frustration, 0);
  assert.equal(s.clarifications, 0); // "anything worth changing here?" is a user turn, not an assistant one
});

test('stripQuotedAndCode removes fences, quotes, indents and inline spans', () => {
  const text = ['intro', '```', 'no this is wrong', '```', '> quoted no', '    indented no', 'tail `no` end'].join('\n');
  const out = stripQuotedAndCode(text);
  assert.equal(/wrong/.test(out), false);
  assert.equal(/quoted/.test(out), false);
  assert.equal(/indented/.test(out), false);
  assert.ok(out.includes('intro') && out.includes('tail'));
  // an unterminated fence swallows the rest: conservative by design
  assert.equal(stripQuotedAndCode('intro\n```\nno this is wrong').trim(), 'intro');
});

// --- interface contract ----------------------------------------------------

test('rates are null when the denominator is zero', () => {
  const r = signalRates(emptySignals());
  assert.deepEqual(r, {
    correction_rate: null, reprompt_rate: null, frustration_rate: null, pushback_rate: null,
    clarification_rate: null, edit_without_read_rate: null, retry_rate: null,
  });
});

test('the marker table is reviewable: unique ids, a note each, no stateful regexes', () => {
  const ids = new Set<string>();
  for (const m of SIGNAL_MARKERS) {
    assert.equal(ids.has(m.id), false, `duplicate marker id ${m.id}`);
    ids.add(m.id);
    assert.ok(m.note.length > 10, `marker ${m.id} needs a note`);
    if (m.test !== 'ALL_CAPS') assert.equal(m.test.global, false, `marker ${m.id} must not use /g`);
    if (m.suppress) assert.equal(m.suppress.global, false, `suppressor ${m.id} must not use /g`);
  }
  assert.ok(ids.size >= 15);
  assert.deepEqual(matchedMarkers("no, that's wrong", 'correction').includes('no_lead'), true);
  assert.deepEqual(matchedMarkers('add undo support', 'correction'), []);
});

test('version is published and the local classifier is a stub', () => {
  assert.equal(typeof SIGNAL_VERSION, 'number');
  assert.ok(SIGNAL_VERSION >= 1);
  assert.equal(localClassifierAvailable(), false);
});

test('activeSeconds counts work, not the night between two sittings', () => {
  const t0 = Date.parse('2026-09-14T09:00:00Z');
  const min = 60_000;
  const turn = (atMin: number): Turn => ({ role: 'user', ts: t0 + atMin * min });

  // Three days between the second turn and the third: the session spans 72
  // hours of wall clock and holds well under twenty minutes of work.
  const resumed = [turn(0), turn(2), { ...turn(3 * 24 * 60), role: 'assistant' as const }, turn(3 * 24 * 60 + 2)];
  const active = activeSeconds(resumed);
  assert.ok(active < 20 * 60, `${active}s should be under twenty minutes`);
  // 2 min + a capped 10 + 2 min + the half-cap allowance.
  assert.equal(active, 2 * 60 + 600 + 2 * 60 + 300);

  // Order does not matter: the turns are sorted before the gaps are taken.
  assert.equal(activeSeconds([...resumed].reverse()), active);

  // A session that ran straight through is counted in full.
  assert.equal(activeSeconds([turn(0), turn(5), turn(9)]), 9 * 60 + 300);

  // Degenerate input: one turn is a flat minute, none is nothing.
  assert.equal(activeSeconds([turn(0)]), 60);
  assert.equal(activeSeconds([]), 0);

  // The cap is the whole mechanism, so it is a parameter.
  assert.equal(activeSeconds([turn(0), turn(60)], 120), 120 + 60);
});
