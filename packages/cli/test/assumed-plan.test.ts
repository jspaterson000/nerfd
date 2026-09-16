import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assumedStamp } from '../src/commands/backfill.ts';
import { refreshDetections } from '../src/plandetect/index.ts';
import { dateGate, pluckDate, pluckJwtDate } from '../src/plandetect/read.ts';
import type { Config } from '../src/paths.ts';

// Backfilled sessions carry no plan, which is why the public plans board was
// empty: months of imported history priced at nothing. The fix is not to stamp
// today's plan on all of it - that would put $200 against sessions run before
// the subscription existed - but only on sessions that ended inside a period
// this machine can prove. These are the fixtures for that proof.

const NO_ENV: NodeJS.ProcessEnv = {};
const cfg = (): Config => ({ install_id: 'x', server: 's', share: 'never', plans: {}, created_at: 'now' }) as Config;

/** An unsigned JWT carrying one claim object. Nothing verifies it; nothing sends it. */
function jwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims)}.FAKE-SIGNATURE-NOT-VERIFIED`;
}

/** A home with a Codex login whose subscription ran for the given window. */
function codexHome(from: string, until: string | null): string {
  const home = mkdtempSync(join(tmpdir(), 'nerfd-assumed-'));
  mkdirSync(join(home, '.codex'), { recursive: true });
  writeFileSync(join(home, '.codex', 'auth.json'), JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      id_token: jwt({
        'https://api.openai.com/auth': {
          chatgpt_plan_type: 'pro',
          chatgpt_subscription_active_start: from,
          chatgpt_subscription_active_until: until,
          // Sitting right next to the dates, and never named by any code path.
          chatgpt_account_id: 'FAKE-ACCOUNT-ID',
        },
        email: 'fake@example.invalid',
      }),
      access_token: 'FAKE-ACCESS-TOKEN',
    },
  }));
  return home;
}

test('an imported session inside the subscription period gets an assumed plan', () => {
  const c = cfg();
  refreshDetections(c, { home: codexHome('2026-01-01T00:00:00Z', '2026-12-31T00:00:00Z'), env: NO_ENV });

  const inside = assumedStamp(c, 'codex', '2026-06-15T12:00:00Z');
  assert.ok(inside, 'a session inside the window can be priced');
  assert.equal(inside.plan_id, 'chatgpt-pro');
  assert.equal(inside.plan_usd_month, 200);
  // Never 'detected': nothing about the session itself said which plan it ran on.
  assert.equal(inside.plan_source, 'assumed');
});

test('an imported session outside the period keeps null and unknown', () => {
  const c = cfg();
  refreshDetections(c, { home: codexHome('2026-01-01T00:00:00Z', '2026-12-31T00:00:00Z'), env: NO_ENV });

  // Before the subscription started: the person was paying nothing, or paying
  // for something else. Guessing here would misprice months of history.
  assert.equal(assumedStamp(c, 'codex', '2025-11-30T12:00:00Z'), null);
  // After it lapsed.
  assert.equal(assumedStamp(c, 'codex', '2027-02-01T12:00:00Z'), null);
  // No end date at all.
  assert.equal(assumedStamp(c, 'codex', null), null);
});

test('a tool that records no subscription period is never assumed at', () => {
  const home = mkdtempSync(join(tmpdir(), 'nerfd-assumed-'));
  mkdirSync(join(home, '.config', 'goose'), { recursive: true });
  writeFileSync(join(home, '.config', 'goose', 'config.yaml'), 'GOOSE_PROVIDER: ollama\n');
  const c = cfg();
  refreshDetections(c, { home, env: NO_ENV });
  assert.equal(assumedStamp(c, 'goose', '2026-06-15T12:00:00Z'), null);
});

test('Claude Code has a start date and no end: the period is open-ended', () => {
  const home = mkdtempSync(join(tmpdir(), 'nerfd-assumed-'));
  writeFileSync(join(home, '.claude.json'), JSON.stringify({
    oauthAccount: {
      organizationRateLimitTier: 'default_claude_max_20x',
      subscriptionCreatedAt: '2026-03-01T00:00:00Z',
      // Identity keys in the same object, never named by any code path.
      emailAddress: 'fake@example.invalid',
      accountUuid: 'FAKE-UUID',
    },
  }));
  const c = cfg();
  refreshDetections(c, { home, env: NO_ENV });

  assert.equal(assumedStamp(c, 'claude-code', '2026-02-01T00:00:00Z'), null, 'before the subscription existed');
  const after = assumedStamp(c, 'claude-code', '2026-09-01T00:00:00Z');
  assert.equal(after?.plan_id, 'claude-max-20x');
  assert.equal(after?.plan_source, 'assumed');
});

test('the date gate lets a date through and nothing else', () => {
  const now = Date.parse('2026-09-16T00:00:00Z');
  assert.equal(dateGate('2026-03-01T00:00:00Z', now), '2026-03-01T00:00:00.000Z');
  assert.equal(dateGate(Math.floor(Date.parse('2026-03-01T00:00:00Z') / 1000), now), '2026-03-01T00:00:00.000Z');
  // A token, a uuid, an email and an org name are not dates.
  for (const junk of ['sk-FAKE-KEY', 'fake@example.invalid', 'FAKE-UUID-0001', 'Acme Corporation', null, {}, []]) {
    assert.equal(dateGate(junk, now), null, String(junk));
  }
  // Nor is a plausible-looking number from the far past or future.
  assert.equal(dateGate('1970-01-01T00:00:00Z', now), null);
  assert.equal(dateGate('2099-01-01T00:00:00Z', now), null);
});

test('the date readers return null rather than a secret when pointed at one', () => {
  const home = codexHome('2026-01-01T00:00:00Z', null);
  const auth = join(home, '.codex', 'auth.json');
  // Aimed at the access token and the account id on purpose.
  assert.equal(pluckJwtDate(auth, ['tokens', 'id_token'], ['https://api.openai.com/auth', 'chatgpt_account_id']), null);
  assert.equal(pluckJwtDate(auth, ['tokens', 'id_token'], ['email']), null);
  assert.equal(pluckDate(auth, ['tokens', 'access_token']), null);
  // An open-ended subscription reads back as a start and no end.
  assert.equal(pluckJwtDate(auth, ['tokens', 'id_token'], ['https://api.openai.com/auth', 'chatgpt_subscription_active_until']), null);
  assert.equal(pluckJwtDate(auth, ['tokens', 'id_token'], ['https://api.openai.com/auth', 'chatgpt_subscription_active_start']), '2026-01-01T00:00:00.000Z');
});
