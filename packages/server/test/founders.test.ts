import test from 'node:test';
import assert from 'node:assert/strict';
import { isoWeek } from '@nerfd/core';
import { applyFounder, FOUNDER_CAP, publicFounders, validateFounder, type FounderRow, type FounderStore } from '../src/founders.ts';

// The founding wall is a list of names by choice. What must hold: a handle
// is one install's, a second call from the same install replaces rather than
// duplicates, the public list carries handles and weeks and nothing else,
// and the wall closes at the cap.

function mem(): FounderStore & { rows: FounderRow[] } {
  const rows: FounderRow[] = [];
  return {
    rows,
    list: () => [...rows],
    get: (h) => rows.find((r) => r.handle === h) ?? null,
    byOwner: (o) => rows.find((r) => r.owner === o) ?? null,
    put: (r) => { const i = rows.findIndex((x) => x.handle === r.handle); if (i >= 0) rows[i] = r; else rows.push(r); },
    remove: (h) => { const i = rows.findIndex((x) => x.handle === h); if (i >= 0) rows.splice(i, 1); },
  };
}
const owner = (n: number) => n.toString(16).padStart(64, '0');
const req = (handle: string, o: number, remove = false) => { const v = validateFounder({ handle, owner: owner(o), remove }); if (!v.ok) throw new Error(v.error); return v.value; };

test('validateFounder accepts an X handle with or without @ and rejects anything else', () => {
  assert.equal(validateFounder({ handle: '@Jacob_1', owner: owner(1) }).ok, true);
  assert.equal((validateFounder({ handle: '@Jacob_1', owner: owner(1) }) as { value: { handle: string } }).value.handle, 'jacob_1');
  assert.equal(validateFounder({ handle: 'sixteen_chars_xx', owner: owner(1) }).ok, false);
  assert.equal(validateFounder({ handle: 'a b', owner: owner(1) }).ok, false);
  assert.equal(validateFounder({ handle: 'ok', owner: 'not-a-hash' }).ok, false);
  assert.equal(validateFounder('ok').ok, false);
});

test('one handle per install, replaced not duplicated, and never taken from another install', () => {
  const s = mem();
  assert.equal(applyFounder(s, req('alice', 1), '2026-09-14T00:00:00Z').status, 201);
  assert.equal(applyFounder(s, req('alice', 1)).body && (applyFounder(s, req('alice', 1)).body as { result: string }).result, 'unchanged');
  assert.equal(applyFounder(s, req('alice', 2)).status, 409, 'someone else cannot claim it');
  const replaced = applyFounder(s, req('alice_new', 1), '2026-09-21T00:00:00Z');
  assert.equal((replaced.body as { result: string }).result, 'replaced');
  assert.equal(s.rows.length, 1);
  assert.equal(s.rows[0]!.handle, 'alice_new');
  assert.equal(s.rows[0]!.added_at, '2026-09-14T00:00:00Z', 'a rename keeps the original arrival');
  assert.equal(applyFounder(s, req('alice_new', 2, true)).status, 403);
  assert.equal(applyFounder(s, req('alice_new', 1, true)).status, 200);
  assert.equal(s.rows.length, 0);
  assert.equal(applyFounder(s, req('alice_new', 1, true)).status, 404);
});

test('the public list is handles and weeks only, oldest first, and the wall has a cap', () => {
  const s = mem();
  applyFounder(s, req('later', 2), '2026-09-21T00:00:00Z');
  applyFounder(s, req('first', 1), '2026-09-14T00:00:00Z');
  const pub = publicFounders(s, isoWeek);
  assert.deepEqual(pub.founders, [{ handle: 'first', since: '2026-W38' }, { handle: 'later', since: '2026-W39' }]);
  assert.ok(!JSON.stringify(pub).includes(owner(1)), 'owner tokens never leave');
  for (let k = 3; k < FOUNDER_CAP + 1; k++) applyFounder(s, req('h' + k, k));
  assert.equal(s.rows.length, FOUNDER_CAP);
  assert.equal(applyFounder(s, req('late', FOUNDER_CAP + 5)).status, 403);
  assert.equal(applyFounder(s, req('first_renamed', 1)).status, 201, 'a rename does not need a free seat');
});
