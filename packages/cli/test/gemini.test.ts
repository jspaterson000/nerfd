import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { geminiAdapter, geminiAuthType, geminiBackfill, geminiTurns, installGeminiCommand, installGeminiHooks } from '../src/adapters/gemini.ts';
import { atLeast, chatHeaderSessionId, listFamilyChats, parseGeminiFamilyChat } from '../src/adapters/gemini-family.ts';
import { CANONICAL_EVENTS } from '../src/adapters/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, 'fixtures', 'gemini', 'tmp');
const CHAT = join(ROOT, '2f1a9c', 'chats', 'session-2026-09-16T10-00-abcd1234.jsonl');

test('the Gemini chat file gives tokens, errors, interrupts and latency', () => {
  const { facts, session_id } = parseGeminiFamilyChat(CHAT, 'gemini');

  // The id inside the file, not the clock-stamped file name.
  assert.equal(session_id, 'g-sess-1');
  assert.equal(facts.model, 'gemini-3-flash-preview');

  // Three model messages, though one of them was appended to the file twice.
  // Without deduplication by message id every number below doubles.
  assert.equal(facts.turns, 3);
  // promptTokenCount already contains the cached prefix: (1000-200) + (1400-400) + 600.
  assert.equal(facts.tokens_in, 2400);
  // Thinking bills as output: (50+30) + (80+20) + (40+10).
  assert.equal(facts.tokens_out, 230);
  assert.equal(facts.tokens_cache_read, 600);

  assert.equal(facts.tool_call_errors, 1);   // the write_file schema error
  assert.equal(facts.context_limit_hits, 1);
  assert.equal(facts.rate_limit_hits, 1);
  assert.equal(facts.api_errors, 2);         // the API error line and the failed tool
  assert.equal(facts.interrupts, 1);         // "Request cancelled."
  assert.deepEqual(facts.latencies_ms, [4000]);
  assert.equal(facts.first_ts, '2026-09-16T10:00:00.000Z');
  assert.equal(facts.last_ts, '2026-09-16T10:01:10.000Z');
});

test('a successful tool result is never scanned for error words', () => {
  // A grep hit or a source file can contain "failed to parse" because the
  // user's code does. Only a failed call's output is matched.
  const dir = mkdtempSync(join(tmpdir(), 'nerfd-gem-'));
  const path = join(dir, 'chat.jsonl');
  writeFileSync(path, [
    JSON.stringify({ sessionId: 's', startTime: '2026-09-16T10:00:00.000Z' }),
    JSON.stringify({
      id: 'm1', timestamp: '2026-09-16T10:00:02.000Z', type: 'gemini', content: '', model: 'gemini-3-pro-preview',
      toolCalls: [{ id: 't', name: 'search_file_content', status: 'success', result: 'throw new Error("failed to parse"); // context window', args: {} }],
    }),
  ].join('\n') + '\n');

  const { facts } = parseGeminiFamilyChat(path, 'gemini');
  assert.equal(facts.tool_call_errors, 0);
  assert.equal(facts.context_limit_hits, 0);
  assert.equal(facts.api_errors, 0);
});

test('turns carry text only when they are asked to', () => {
  // The ledger path must not produce prompt text, file paths or commands: it
  // is what gets stored. The signal path asks for them and drops them.
  const quiet = parseGeminiFamilyChat(CHAT, 'gemini').turns;
  assert.ok(quiet.length > 0);
  for (const t of quiet) {
    assert.equal(t.text, undefined);
    assert.equal(t.path, undefined);
    assert.equal(t.command, undefined);
  }
  // `ends_with_question` is computed from the text, not stored text.
  assert.equal(quiet.filter((t) => t.ends_with_question).length, 1);

  const loud = geminiTurns(CHAT);
  assert.deepEqual(loud.map((t) => t.role), ['user', 'assistant', 'tool', 'assistant', 'tool', 'tool', 'assistant']);
  assert.match(loud[0]!.text!, /retry/);
  assert.equal(loud[2]!.path, '/tmp/proj/fetcher.ts');
  assert.equal(loud[2]!.ok, true);
  assert.equal(loud[4]!.ok, false);            // write_file failed
  assert.equal(loud[5]!.interrupted, true);    // the cancelled search
  assert.equal(loud[3]!.interrupted, true);    // the turn the user cancelled
  assert.equal(loud[1]!.thinking_tokens, 30);
  assert.equal(loud[6]!.ends_with_question, true);
});

test('normalise maps Gemini events onto the canonical vocabulary', () => {
  const g = geminiAdapter;
  const ev = (input: Record<string, unknown>) => g.normalise({ session_id: 's1', ...input });

  assert.equal(ev({ hook_event_name: 'SessionStart' })!.hook_event_name, 'SessionStart');
  assert.equal(ev({ hook_event_name: 'SessionEnd', reason: 'exit' })!.hook_event_name, 'SessionEnd');
  assert.equal(ev({ hook_event_name: 'BeforeAgent', prompt: 'hi' })!.hook_event_name, 'UserPromptSubmit');
  assert.equal(ev({ hook_event_name: 'AfterTool', tool_name: 'write_file', tool_response: { llmContent: 'ok' } })!.hook_event_name, 'PostToolUse');

  const failed = ev({ hook_event_name: 'AfterTool', tool_name: 'write_file', tool_response: { error: 'invalid tool parameter' } })!;
  assert.equal(failed.hook_event_name, 'PostToolUseFailure');
  assert.equal(failed.error, 'invalid tool parameter');

  // BeforeModel exists to carry the model id, and does nothing without one.
  const model = ev({ hook_event_name: 'BeforeModel', llm_request: { model: 'gemini-3-pro-preview', messages: [] } })!;
  assert.equal(model.hook_event_name, 'SessionStart');
  assert.equal(model.model, 'gemini-3-pro-preview');
  assert.equal(ev({ hook_event_name: 'BeforeModel', llm_request: {} }), null);

  // Not scored: an output payload, a UI notification, a pre-event.
  for (const name of ['AfterModel', 'Notification', 'BeforeTool', 'BeforeToolSelection', 'AfterAgent', 'PreCompress', 'Nonsense']) {
    assert.equal(ev({ hook_event_name: name }), null, name);
  }
  assert.equal(g.normalise(null), null);
  assert.equal(g.normalise('SessionStart'), null);

  for (const e of [{ hook_event_name: 'SessionStart' }, { hook_event_name: 'AfterTool', tool_response: {} }]) {
    assert.ok((CANONICAL_EVENTS as readonly string[]).includes(ev(e)!.hook_event_name));
  }

  // The rest of the payload survives untouched.
  const kept = ev({ hook_event_name: 'AfterTool', tool_name: 'write_file', tool_input: { file_path: '/x' }, tool_response: {} })!;
  assert.equal(kept.tool_name, 'write_file');
  assert.deepEqual(kept.tool_input, { file_path: '/x' });
});

test('hooks merge into settings.json and come back out cleanly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nerfd-gem-'));
  const path = join(dir, 'settings.json');
  const before = {
    security: { auth: { selectedType: 'oauth-personal' } },
    general: { previewFeatures: true },
    hooks: {
      // Somebody else's hook on an event we also want. It must survive.
      AfterTool: [{ matcher: 'write_file', hooks: [{ type: 'command', command: 'echo theirs' }] }],
      PreCompress: [{ hooks: [{ type: 'command', command: 'echo mine' }] }],
    },
  };
  writeFileSync(path, JSON.stringify(before, null, 2));

  assert.equal(installGeminiHooks(path), path);
  const after = JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
  assert.deepEqual(after.security, before.security);
  assert.deepEqual(Object.keys(after.hooks).sort(), ['AfterTool', 'PreCompress', 'BeforeAgent', 'SessionEnd', 'SessionStart'].sort());
  assert.equal(after.hooks.AfterTool.length, 2);
  assert.equal(after.hooks.AfterTool[0].hooks[0].command, 'echo theirs');

  const ours = after.hooks.SessionEnd[0].hooks[0];
  assert.equal(ours.type, 'command');
  assert.equal(ours.nerfd, true);
  assert.equal(ours.timeout, 30_000); // Gemini's timeouts are milliseconds
  assert.match(ours.command, /hook gemini$/);
  assert.match(ours.name, /^nerfd-/);
  // A backup is written before the file is touched.
  assert.ok(readdirSync(dir).some((f) => f.includes('.bak-nerfd-')));

  // Uninstall restores exactly what was there, including the other tool's hook.
  installGeminiHooks(path, true);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), before);
});

test('the /nerfd command is a TOML custom command', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nerfd-gem-'));
  const path = join(dir, 'commands', 'nerfd.toml');
  installGeminiCommand(path);
  const toml = readFileSync(path, 'utf8');
  assert.match(toml, /^description = /m);
  assert.match(toml, /prompt = """/);
  assert.match(toml, /!\{.*rate last \{\{args\}\}\}/);
  installGeminiCommand(path, true);
  assert.equal(readFileSync(path, 'utf8'), '');
});

test('the auth type is read from settings, and no credential file is', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nerfd-gem-'));
  const nested = join(dir, 'nested.json');
  writeFileSync(nested, JSON.stringify({ security: { auth: { selectedType: 'vertex-ai' } } }));
  assert.equal(geminiAuthType(nested), 'vertex-ai');

  const flat = join(dir, 'flat.json');
  writeFileSync(flat, JSON.stringify({ selectedAuthType: 'gemini-api-key' }));
  assert.equal(geminiAuthType(flat), 'gemini-api-key');

  assert.equal(geminiAuthType(join(dir, 'missing.json')), null);
  writeFileSync(join(dir, 'broken.json'), '{ nope');
  assert.equal(geminiAuthType(join(dir, 'broken.json')), null);
});

test('the version gate keeps hooks off builds that predate them', () => {
  assert.equal(atLeast('0.41.2', '0.20.0'), true);
  assert.equal(atLeast('0.20.0', '0.20.0'), true);
  assert.equal(atLeast('0.19.4', '0.20.0'), false);
  assert.equal(atLeast('1.0.0', '0.20.0'), true);
  assert.equal(atLeast(null, '0.20.0'), false); // no binary, no claim
});

test('chat files are found by name and by the id inside them', () => {
  const files = listFamilyChats([ROOT], '2020-01-01T00:00:00.000Z');
  assert.equal(files.length, 1);
  assert.equal(files[0]!.path, CHAT);
  assert.equal(chatHeaderSessionId(CHAT), 'g-sess-1');
  assert.equal(listFamilyChats([ROOT], '2099-01-01T00:00:00.000Z').length, 0);
  assert.deepEqual(listFamilyChats([join(ROOT, 'nope')], '2020-01-01T00:00:00.000Z'), []);
});

test('backfill turns a chat file into a session with counts and no content', () => {
  const sessions = geminiBackfill([ROOT], '2020-01-01T00:00:00.000Z');
  assert.equal(sessions.length, 1);
  const s = sessions[0]!;

  assert.equal(s.id, 'g-sess-1');
  assert.equal(s.tool, 'gemini');
  assert.equal(s.source, 'backfill');
  assert.equal(s.model, 'gemini-3-flash-preview');
  assert.equal(s.model_ref.family, 'gemini');
  assert.ok(['google', 'google-vertex'].includes(s.model_ref.raw_provider ?? ''));
  assert.equal(s.metrics.turns, 3);
  assert.equal(s.metrics.tokens_in, 2400);
  assert.equal(s.metrics.tool_call_errors, 1);
  assert.equal(s.metrics.context_limit_hits, 1);
  assert.equal(s.duration_s, 70);
  // The signals are computed from the turns and the turns are then gone.
  assert.ok(s.signals == null || typeof s.signals.user_turns === 'number');

  // Nothing from the conversation is stored: no prompt, no path, no command.
  assert.equal(s.first_prompt, null);
  assert.equal(s.cwd, null);
  assert.deepEqual(s.touched_files, []);
  const stored = JSON.stringify({ ...s, transcript_path: null });
  for (const leak of ['retry to the fetch helper', 'fetcher.ts', '/tmp/proj', 'Request cancelled', 'add a test as well']) {
    assert.equal(stored.includes(leak), false, leak);
  }

  assert.deepEqual(geminiBackfill([ROOT], '2099-01-01T00:00:00.000Z'), []);
});
