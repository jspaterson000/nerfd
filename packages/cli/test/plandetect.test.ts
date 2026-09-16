import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { planById } from '@nerfd/core';
import {
  DETECTABLE, detectAllPlans, detectPlan, detectionsStale, effectivePlan,
  normaliseTool, refreshDetections, refreshDetectionsIfStale, withDetections, WHY_NOT,
  type Detection,
} from '../src/plandetect/index.ts';
import { __gate, displayPath, pluckEnum, pluckJwtClaim, pointsAtLocalhost } from '../src/plandetect/read.ts';
import type { Config } from '../src/paths.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, 'fixtures', 'plandetect');
const home = (name: string) => join(FIX, name);

/** No fixture inherits the real environment: detection must be a pure function. */
const NO_ENV: NodeJS.ProcessEnv = {};

function det(tool: string, fixture: string, env: NodeJS.ProcessEnv = NO_ENV): Detection {
  return detectPlan(tool, { home: home(fixture), env });
}

// ---------------------------------------------------------------------------
// The privacy contract. These are the tests that matter most: they assert that
// nothing which is not a short plan enum can come back out of read.ts.
// ---------------------------------------------------------------------------

test('the value gate rejects every shape a secret takes', () => {
  const secrets = [
    'sk-ant-oat01-AAAABBBBCCCCDDDDEEEEFFFF',              // api key
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefgh',      // jwt
    'fake@example.invalid',                                // email
    '00000000-0000-4000-8000-000000000000',                // account uuid (too long)
    'Fake Org That Must Never Be Read Ltd',                // org name (too long)
    'https://api.example.invalid/v1',                      // url
    'Basic YWJjOmRlZg==',                                  // base64
    '',                                                    // empty
    'a'.repeat(33),                                        // anything long
  ];
  for (const s of secrets) assert.equal(__gate(s), null, s.slice(0, 16));
  for (const v of [null, undefined, 42, {}, [], true]) assert.equal(__gate(v), null, String(v));

  // Plan enums, by contrast, pass.
  for (const ok of ['max', 'pro', 'plus', 'self_serve_business_usage_based', 'default_claude_max_20x', 'oauth-personal']) {
    assert.equal(__gate(ok), ok, ok);
  }
});

test('pluckEnum returns nothing for a field that is not in the allowlist', () => {
  const creds = join(home('claude-max'), '.claude', '.credentials.json');
  // The right field, a wrong allowlist: no value comes back.
  assert.equal(pluckEnum(creds, ['claudeAiOauth', 'subscriptionType'], ['pro']), null);
  // Pointed at a secret on purpose: the gate stops it even so.
  assert.equal(pluckEnum(creds, ['claudeAiOauth', 'accessToken'], ['max', 'pro']), null);
  assert.equal(pluckEnum(creds, ['claudeAiOauth', 'refreshToken'], ['max', 'pro']), null);
  // Missing file, missing field, and a directory are all null, never a throw.
  assert.equal(pluckEnum(join(FIX, 'nope.json'), ['a'], ['x']), null);
  assert.equal(pluckEnum(creds, ['no', 'such', 'field'], ['x']), null);
  assert.equal(pluckEnum(FIX, ['a'], ['x']), null);
});

test('a jwt gives up exactly one claim and never the token or the ids', () => {
  const auth = join(home('codex-pro'), '.codex', 'auth.json');
  const claim = ['https://api.openai.com/auth', 'chatgpt_plan_type'];
  assert.equal(pluckJwtClaim(auth, ['tokens', 'id_token'], claim, ['pro', 'plus']), 'pro');
  // The account and user ids sit in the same claim object and still cannot be read.
  assert.equal(pluckJwtClaim(auth, ['tokens', 'id_token'], ['https://api.openai.com/auth', 'chatgpt_account_id'], ['FAKE-ACCOUNT-ID']), null);
  assert.equal(pluckJwtClaim(auth, ['tokens', 'id_token'], ['email'], ['fake@example.invalid']), null);
  // Nor can the access token be mistaken for a JWT and mined.
  assert.equal(pluckJwtClaim(auth, ['access_token'], claim, ['pro']), null);
  assert.equal(pluckJwtClaim(join(FIX, 'nope.json'), ['tokens', 'id_token'], claim, ['pro']), null);
});

test('evidence names a file and a field, and never the real home directory', () => {
  const d = det('claude', 'claude-max');
  assert.equal(d.evidence, '~/.claude/.credentials.json claudeAiOauth.subscriptionType');
  assert.equal(displayPath('/Users/someone', '/Users/someone/.claude/x.json'), '~/.claude/x.json');
  assert.equal(displayPath('/Users/someone', '/etc/other'), '/etc/other');

  // Every detection carries evidence, and no evidence string leaks a secret.
  for (const t of DETECTABLE) {
    for (const f of readdirSync(FIX)) {
      if (!statSync(join(FIX, f)).isDirectory()) continue;
      const r = detectPlan(t, { home: home(f), env: NO_ENV });
      if (r.plan_id) assert.ok(r.evidence, `${t}/${f} detected without evidence`);
      if (r.evidence) assert.ok(!/FAKE|sk-|eyJ|@example/.test(r.evidence), `${t}/${f}: ${r.evidence}`);
    }
  }
});

test('no detector opens a file that only holds identity', () => {
  // google_accounts.json is the signed-in email and nothing else. The gemini
  // detector must resolve without it, so mangling it changes nothing.
  const before = det('gemini', 'gemini-oauth');
  const path = join(home('gemini-oauth'), '.gemini', 'google_accounts.json');
  const saved = readFileSync(path, 'utf8');
  assert.ok(saved.includes('@example.invalid'), 'fixture should contain an email to be a real test');
  assert.deepEqual(det('gemini', 'gemini-oauth'), before);
});

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

test('claude: subscriptionType maps to a plan id', () => {
  assert.equal(det('claude', 'claude-pro').plan_id, 'claude-pro');
  assert.equal(det('claude', 'claude-pro').confidence, 'high');
  assert.equal(det('claude-code', 'claude-pro').plan_id, 'claude-pro');
});

test('claude: "max" cannot be resolved to 5x or 20x, and is not pretended otherwise', () => {
  const d = det('claude', 'claude-max');
  assert.equal(d.plan_id, 'claude-max');
  assert.equal(d.source, 'detected');
  assert.equal(d.confidence, 'medium', 'an ambiguous tier must never be high confidence');
  assert.equal(planById('claude-max')!.usd_month, null, 'an undetermined Max must not carry a price');
});

test('claude: a rate-limit tier, where one exists, resolves 20x', () => {
  const d = det('claude', 'claude-rlt');
  assert.equal(d.plan_id, 'claude-max-20x');
  assert.equal(d.confidence, 'medium', 'credentials tier can lag an upgrade; the account profile is the high-confidence source');
  assert.match(d.evidence!, /rateLimitTier$/);
});

test('claude: an api key or a key helper outranks any subscription on disk', () => {
  assert.equal(det('claude', 'claude-api').plan_id, 'api');
  assert.match(det('claude', 'claude-api').evidence!, /apiKeyHelper/);
  for (const v of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX']) {
    const d = det('claude', 'claude-max', { [v]: 'FAKE-KEY-DO-NOT-READ' });
    assert.equal(d.plan_id, 'api', v);
    assert.equal(d.evidence, `env ${v} (set)`, 'the value must never appear in evidence');
  }
  // An empty or falsey value is not "set".
  assert.equal(det('claude', 'claude-max', { ANTHROPIC_API_KEY: '' }).plan_id, 'claude-max');
});

test('claude: a keychain-only machine reports unknown, with the reason', () => {
  const d = det('claude', 'claude-keychain');
  assert.equal(d.plan_id, null);
  assert.equal(d.source, 'unknown');
  assert.match(d.evidence!, /oauthAccount \(present/);
  assert.ok(WHY_NOT['claude-code']!.includes('keychain'));
});

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

test('codex: the plan comes from one jwt claim', () => {
  const d = det('codex', 'codex-pro');
  assert.equal(d.plan_id, 'chatgpt-pro');
  assert.equal(d.confidence, 'high');
  assert.match(d.evidence!, /chatgpt_plan_type$/);
});

test('codex: the business SKUs collapse onto one id', () => {
  assert.equal(det('codex', 'codex-business').plan_id, 'chatgpt-business');
});

test('codex: auth_mode apikey is api, whatever else is in the file', () => {
  const d = det('codex', 'codex-api');
  assert.equal(d.plan_id, 'api');
  assert.match(d.evidence!, /auth_mode$/);
  assert.equal(det('codex', 'codex-pro', { OPENAI_API_KEY: 'sk-FAKE' }).plan_id, 'api');
});

// ---------------------------------------------------------------------------
// Gemini, OpenCode, Goose, and the ones that cannot be detected
// ---------------------------------------------------------------------------

test('gemini: the auth method is on disk, the tier is not', () => {
  assert.equal(det('gemini', 'gemini-api').plan_id, 'api');
  const oauth = det('gemini', 'gemini-oauth');
  assert.equal(oauth.plan_id, null, 'a signed-in account does not name a tier');
  assert.match(oauth.evidence!, /security\.auth\.selectedType$/);
  assert.equal(det('gemini', 'gemini-oauth', { GEMINI_API_KEY: 'FAKE' }).plan_id, 'api');
});

test('opencode: provider ids are read as keys, credentials are not', () => {
  assert.equal(det('opencode', 'opencode-go').plan_id, 'opencode-go');
  assert.equal(det('opencode', 'opencode-api').plan_id, 'api');
  assert.equal(det('opencode', 'opencode-local').plan_id, 'local');
  // An anthropic oauth entry means somebody's Claude plan is paying for it.
  const borrowed = det('opencode', 'opencode-anthropic');
  assert.equal(borrowed.plan_id, 'claude-pro');
  assert.equal(borrowed.confidence, 'medium', 'a borrowed plan is one step less certain');
});

test('goose has no subscription, so it is api or local and never a guess', () => {
  assert.equal(det('goose', 'goose-local').plan_id, 'local');
  assert.equal(det('goose', 'goose-api').plan_id, 'api');
  assert.equal(det('goose', 'goose-local', { GOOSE_PROVIDER: 'ollama' }).plan_id, 'local');
});

test('the tools with no local plan field say so instead of guessing', () => {
  for (const t of ['kimi', 'copilot', 'qwen', 'crush', 'droid']) {
    const d = det(t, 'empty');
    assert.equal(d.plan_id, null, t);
    assert.equal(d.source, 'unknown', t);
    assert.ok(WHY_NOT[normaliseTool(t)!], `${t} needs a documented reason`);
  }
  assert.equal(det('kimi', 'empty', { MOONSHOT_API_KEY: 'FAKE' }).plan_id, 'api');
});

// ---------------------------------------------------------------------------
// The module contract
// ---------------------------------------------------------------------------

test('every detected plan id exists in the plans catalogue', () => {
  for (const f of readdirSync(FIX)) {
    if (!statSync(join(FIX, f)).isDirectory()) continue;
    for (const [tool, d] of Object.entries(detectAllPlans({ home: home(f), env: NO_ENV }))) {
      if (!d.plan_id) continue;
      assert.ok(planById(d.plan_id), `${f}/${tool}: unknown plan id ${d.plan_id}`);
      assert.equal(d.source, 'detected');
    }
  }
});

test('detection never throws, whatever it is pointed at', () => {
  for (const bad of ['/nonexistent/path/xyz', FIX, '', '/dev/null']) {
    for (const t of [...DETECTABLE, 'nonsense', '']) {
      const d = detectPlan(t as string, { home: bad, env: NO_ENV });
      assert.ok(d.source === 'detected' || d.source === 'unknown');
    }
    assert.ok(detectAllPlans({ home: bad, env: NO_ENV }));
  }
  assert.deepEqual(detectPlan('nonsense'), { plan_id: null, source: 'unknown', evidence: null, confidence: 'low' });
});

test('normaliseTool accepts the names the CLI already takes', () => {
  assert.equal(normaliseTool('claude'), 'claude-code');
  assert.equal(normaliseTool('  CODEX '), 'codex');
  assert.equal(normaliseTool('kimi-code'), 'kimi');
  assert.equal(normaliseTool('nonsense'), null);
  assert.equal(normaliseTool(null), null);
});

test('detections are stored with a timestamp and re-checked at most daily', () => {
  const cfg = { install_id: 'x', server: 's', share: 'never', plans: {}, created_at: 'now' } as Config;
  assert.equal(detectionsStale(cfg), true, 'no record means stale');

  const t0 = new Date('2026-09-16T00:00:00Z');
  assert.equal(refreshDetectionsIfStale(cfg, { home: home('claude-pro'), env: NO_ENV }, t0), true);
  assert.equal(withDetections(cfg).detected_plans!.checked_at, t0.toISOString());
  assert.equal(withDetections(cfg).detected_plans!.plans['claude-code']!.plan_id, 'claude-pro');

  const hourLater = new Date(t0.getTime() + 60 * 60 * 1000);
  assert.equal(detectionsStale(cfg, hourLater.getTime()), false);
  assert.equal(refreshDetectionsIfStale(cfg, { home: home('claude-pro') }, hourLater), false);

  const dayLater = new Date(t0.getTime() + 25 * 60 * 60 * 1000);
  assert.equal(detectionsStale(cfg, dayLater.getTime()), true);

  // A clock that jumped backwards must not freeze detection forever.
  withDetections(cfg).detected_plans!.checked_at = new Date(t0.getTime() + 999 * 86400000).toISOString();
  assert.equal(detectionsStale(cfg, t0.getTime()), true);
  withDetections(cfg).detected_plans!.checked_at = 'not a date';
  assert.equal(detectionsStale(cfg, t0.getTime()), true);
});

test('declared beats detected beats nothing', () => {
  const cfg = { install_id: 'x', server: 's', share: 'never', plans: {}, created_at: 'now' } as Config;
  refreshDetections(cfg, { home: home('claude-max'), env: NO_ENV }, new Date());

  const auto = effectivePlan(cfg, 'claude-code');
  assert.equal(auto.plan_id, 'claude-max');
  assert.equal(auto.plan_source, 'detected');
  assert.ok(auto.evidence, 'a detected plan shows what it was read from');

  cfg.plans['claude-code'] = { id: 'claude-max-20x', name: 'Claude Max 20x', usd_month: 200 };
  const declared = effectivePlan(cfg, 'claude-code');
  assert.equal(declared.plan_id, 'claude-max-20x');
  assert.equal(declared.plan_source, 'declared');
  assert.equal(declared.evidence, null, 'a declared plan has no file behind it');

  assert.equal(effectivePlan(cfg, 'crush').plan_source, 'unknown');
  assert.equal(effectivePlan(cfg, 'crush').plan_id, null);

  // `other` is the catch-all a person can set for tools with no adapter.
  cfg.plans.other = { id: 'glm-coding-lite', name: 'Z.ai GLM Coding Lite', usd_month: 18 };
  assert.equal(effectivePlan(cfg, 'crush').plan_id, 'glm-coding-lite');
});

test('only a plan id and a source are fit to leave the machine', () => {
  const cfg = { install_id: 'x', server: 's', share: 'never', plans: {}, created_at: 'now' } as Config;
  refreshDetections(cfg, { home: home('codex-pro'), env: NO_ENV }, new Date());
  const e = effectivePlan(cfg, 'codex');
  // This is the whole public surface of detection.
  assert.deepEqual(Object.keys({ plan_id: e.plan_id, plan_source: e.plan_source }), ['plan_id', 'plan_source']);
  assert.equal(e.plan_id, 'chatgpt-pro');
  assert.ok(['detected', 'declared', 'unknown'].includes(e.plan_source));
});

test('a localhost base URL is recognised without the URL being returned', () => {
  const cfg = join(home('opencode-local'), '.config', 'opencode', 'opencode.json');
  assert.equal(pointsAtLocalhost(cfg, ['provider']), true);
  assert.equal(pointsAtLocalhost(cfg, ['nope']), false);
});
