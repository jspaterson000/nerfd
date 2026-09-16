import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  installQwenCommand, installQwenHooks, providerFromUrl, qwenAdapter, qwenBackfill, qwenConfig,
  qwenIdentity, qwenTurns,
} from '../src/adapters/qwen.ts';
import { parseGeminiFamilyChat } from '../src/adapters/gemini-family.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, 'fixtures', 'qwen', 'projects');
const CHAT = join(ROOT, '-tmp-proj', 'chats', 'q-sess-1.jsonl');

test('the Qwen chat file gives tokens, compaction, tool errors and latency', () => {
  const { facts, session_id } = parseGeminiFamilyChat(CHAT, 'qwen');

  assert.equal(session_id, 'q-sess-1');
  assert.equal(facts.model, 'qwen3-coder-plus');
  assert.equal(facts.tool_version, '0.23.4'); // Qwen stamps every record

  // Three assistant records, one of them appended to the file twice.
  assert.equal(facts.turns, 3);
  // usageMetadata is Gemini's shape by another name: promptTokenCount already
  // contains the cached prefix, thoughts bill as output.
  assert.equal(facts.tokens_in, 1500 + 1800 + 900);
  assert.equal(facts.tokens_out, 160 + 100 + 65);
  assert.equal(facts.tokens_cache_read, 1300);

  assert.equal(facts.tool_call_errors, 1);   // "failed to parse" on a tool result
  assert.equal(facts.api_errors, 1);         // the same call, as a failure
  assert.equal(facts.context_limit_hits, 1); // the chat_compression record
  assert.equal(facts.interrupts, 0);
  // Prompt to reply, then each tool result to the reply that followed it.
  assert.deepEqual(facts.latencies_ms, [6000, 12000, 23000]);
});

test('a tool call and its later result become one turn', () => {
  const quiet = parseGeminiFamilyChat(CHAT, 'qwen').turns;
  for (const t of quiet) {
    assert.equal(t.text, undefined);
    assert.equal(t.path, undefined);
    assert.equal(t.command, undefined);
  }

  const turns = qwenTurns(CHAT);
  assert.deepEqual(turns.map((t) => t.role), ['user', 'assistant', 'tool', 'assistant', 'tool', 'assistant']);
  // The arguments come from the assistant's functionCall, the outcome from the
  // tool_result that answers it; they are joined on the call id.
  assert.equal(turns[2]!.tool, 'read_file');
  assert.equal(turns[2]!.path, '/tmp/proj/parser.ts');
  assert.equal(turns[2]!.ok, true);
  assert.equal(turns[4]!.tool, 'run_shell_command');
  assert.equal(turns[4]!.command, 'pnpm test');
  assert.equal(turns[4]!.ok, false);
  assert.equal(turns[5]!.ends_with_question, true);
  assert.equal(turns[1]!.thinking_tokens, 40);
});

test('normalise maps Qwen events onto the canonical vocabulary', () => {
  const q = qwenAdapter;
  const ev = (input: Record<string, unknown>) => q.normalise({ session_id: 's1', ...input });

  for (const name of ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'StopFailure', 'SessionEnd']) {
    assert.equal(ev({ hook_event_name: name, tool_response: {} })!.hook_event_name, name, name);
  }
  // SessionStart carries the model, which Gemini's does not.
  assert.equal(ev({ hook_event_name: 'SessionStart', model: 'qwen3-coder-plus' })!.model, 'qwen3-coder-plus');

  // A tool that reports an error is a failure whatever the event was called.
  const failed = ev({ hook_event_name: 'PostToolUse', tool_name: 'edit', tool_response: { error: 'invalid tool parameter' } })!;
  assert.equal(failed.hook_event_name, 'PostToolUseFailure');

  for (const name of ['PreToolUse', 'PostToolBatch', 'Notification', 'PreCompact', 'PostCompact', 'SubagentStop', 'TodoCreated', 'PermissionDenied', 'Nonsense']) {
    assert.equal(ev({ hook_event_name: name }), null, name);
  }
  assert.equal(q.normalise(null), null);
  assert.equal(q.normalise('SessionStart'), null);
});

test('hooks merge into settings.json and come back out cleanly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nerfd-qwen-'));
  const path = join(dir, 'settings.json');
  const before = {
    security: { auth: { selectedType: 'qwen-oauth' } },
    disableAllHooks: false,
    hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'http', url: 'https://example.invalid/theirs' }] }] },
  };
  writeFileSync(path, JSON.stringify(before, null, 2));

  installQwenHooks(path);
  const after = JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
  assert.equal(after.disableAllHooks, false);
  assert.deepEqual(after.security, before.security);
  assert.equal(after.hooks.Stop.length, 2);
  assert.equal(after.hooks.Stop[0].hooks[0].url, 'https://example.invalid/theirs');

  const ours = after.hooks.SessionEnd[0].hooks[0];
  assert.equal(ours.type, 'command');  // never `http`: the metric stays local
  assert.equal(ours.timeout, 30);      // Qwen's timeouts are seconds
  assert.equal(ours.nerfd, true);
  assert.match(ours.command, /hook qwen$/);
  assert.ok(readdirSync(dir).some((f) => f.includes('.bak-nerfd-')));

  installQwenHooks(path, true);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), before);
});

test('the /nerfd command is a markdown custom command', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nerfd-qwen-'));
  const path = join(dir, 'commands', 'nerfd.md');
  installQwenCommand(path);
  const md = readFileSync(path, 'utf8');
  assert.match(md, /^---\ndescription: /);
  assert.match(md, /rate last \{\{args\}\}/);
  installQwenCommand(path, true);
  assert.equal(readFileSync(path, 'utf8'), '');
});

test('the endpoint is read from settings and the key never is', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nerfd-qwen-'));
  const path = join(dir, 'settings.json');
  writeFileSync(path, JSON.stringify({
    security: { auth: { selectedType: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: 'sk-do-not-read-me' } },
    modelProviders: { openai: [{ id: 'qwen3-coder-plus', envKey: 'OPENAI_API_KEY', baseUrl: 'https://ignored.invalid/v1', name: 'Qwen3 Coder Plus AWQ int4' }] },
  }, null, 2));

  const cfg = qwenConfig(path);
  assert.equal(cfg.auth_type, 'openai');
  assert.equal(cfg.base_url, 'https://dashscope.aliyuncs.com/compatible-mode/v1');
  // The key is in the file and must not be anywhere in what comes back.
  assert.equal(JSON.stringify(cfg).includes('sk-do-not-read-me'), false);
  assert.equal(JSON.stringify(cfg).includes('OPENAI_API_KEY'), false);

  assert.deepEqual(qwenConfig(join(dir, 'missing.json')), { auth_type: null, base_url: null, declared_name: null });
});

test('who served it comes from the endpoint, then the auth type', () => {
  assert.equal(providerFromUrl('https://dashscope.aliyuncs.com/compatible-mode/v1'), 'alibaba');
  assert.equal(providerFromUrl('https://dashscope-intl.aliyuncs.com/compatible-mode/v1'), 'alibaba');
  assert.equal(providerFromUrl('https://openrouter.ai/api/v1'), 'openrouter');
  assert.equal(providerFromUrl('https://api.moonshot.cn/v1'), 'moonshotai');
  assert.equal(providerFromUrl('http://localhost:11434/v1'), null); // left to the resolver
  assert.equal(providerFromUrl(null), null);
  assert.equal(providerFromUrl('not a url at all'), null);

  // Qwen's own OAuth means Alibaba served it.
  assert.equal(qwenIdentity('qwen3-coder-plus', { auth_type: 'qwen-oauth', base_url: null, declared_name: null }).raw_provider, 'alibaba');
  // A local runtime keeps its base URL, and the resolver decides from there.
  const local = qwenIdentity('qwen3-coder', { auth_type: 'openai', base_url: 'http://localhost:11434/v1', declared_name: 'Qwen3 Coder 30B-A3B q4_K_M' });
  assert.equal(local.raw_provider, null);
  assert.equal(local.base_url, 'http://localhost:11434/v1');
  assert.equal(local.declared_name, 'Qwen3 Coder 30B-A3B q4_K_M');
});

test('backfill turns a chat file into a session with counts and no content', () => {
  const sessions = qwenBackfill([ROOT], '2020-01-01T00:00:00.000Z');
  assert.equal(sessions.length, 1);
  const s = sessions[0]!;

  assert.equal(s.id, 'q-sess-1');
  assert.equal(s.tool, 'qwen');
  assert.equal(s.source, 'backfill');
  assert.equal(s.model, 'qwen3-coder-plus');
  assert.equal(s.tool_version, '0.23.4');
  assert.equal(s.metrics.turns, 3);
  assert.equal(s.metrics.tokens_in, 4200);
  assert.equal(s.metrics.tool_call_errors, 1);
  assert.equal(s.metrics.context_limit_hits, 1);
  assert.equal(s.duration_s, 44);

  assert.equal(s.first_prompt, null);
  assert.equal(s.cwd, null);
  assert.deepEqual(s.touched_files, []);
  const stored = JSON.stringify({ ...s, transcript_path: null });
  for (const leak of ['port the parser', 'parser.ts', '/tmp/proj', 'pnpm test', 'run the tests again']) {
    assert.equal(stored.includes(leak), false, leak);
  }

  assert.deepEqual(qwenBackfill([ROOT], '2099-01-01T00:00:00.000Z'), []);
});
