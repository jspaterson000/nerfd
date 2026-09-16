// The founding reporters wall: an opt-in list of X handles for the people who
// installed in the first month. It is a vanity list by choice and nothing
// else: a handle is stored with a hash the CLI derives from the install id,
// so the owner can remove it, and with the week it was added. It is never
// joined to a report, a reporter id or a session. The data stays
// pseudonymous whether or not a person puts their name here.

export const FOUNDER_HANDLE_RE = /^@?[A-Za-z0-9_]{1,15}$/;
export const FOUNDER_OWNER_RE = /^[0-9a-f]{64}$/;
/** Room for a first month, not a directory. */
export const FOUNDER_CAP = 500;

export interface FounderRow { handle: string; owner: string; added_at: string }

/** What a store must offer; the Node server and the Worker each implement it. */
export interface FounderStore {
  list(): FounderRow[];
  get(handle: string): FounderRow | null;
  byOwner(owner: string): FounderRow | null;
  put(row: FounderRow): void;
  remove(handle: string): void;
}

export interface FounderRequest { handle: string; owner: string; remove: boolean }

export function normaliseHandle(h: string): string {
  return h.trim().replace(/^@/, '').toLowerCase();
}

export function validateFounder(x: unknown): { ok: true; value: FounderRequest } | { ok: false; error: string } {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return { ok: false, error: 'invalid body' };
  const b = x as Record<string, unknown>;
  if (typeof b.handle !== 'string' || !FOUNDER_HANDLE_RE.test(b.handle.trim())) return { ok: false, error: 'handle must be an X handle: 1-15 letters, digits or underscores' };
  if (typeof b.owner !== 'string' || !FOUNDER_OWNER_RE.test(b.owner)) return { ok: false, error: 'owner invalid' };
  if (b.remove != null && typeof b.remove !== 'boolean') return { ok: false, error: 'remove invalid' };
  return { ok: true, value: { handle: normaliseHandle(b.handle), owner: b.owner, remove: b.remove === true } };
}

/** The public list: handles and the week each arrived, oldest first, nothing else. */
export function publicFounders(store: FounderStore, isoWeek: (iso: string) => string): { founders: Array<{ handle: string; since: string }>; n: number; cap: number } {
  const rows = store.list().sort((a, b) => a.added_at.localeCompare(b.added_at));
  return { founders: rows.map((r) => ({ handle: r.handle, since: isoWeek(r.added_at) })), n: rows.length, cap: FOUNDER_CAP };
}

/**
 * Add, replace or remove one handle. One handle per owner: a second call
 * from the same install replaces the first. A handle someone else holds is
 * refused. The wall closes at the cap.
 */
export function applyFounder(store: FounderStore, req: FounderRequest, now = new Date().toISOString()): { status: number; body: unknown } {
  const existing = store.get(req.handle);
  if (req.remove) {
    if (!existing) return { status: 404, body: { error: 'handle not on the wall' } };
    if (existing.owner !== req.owner) return { status: 403, body: { error: 'handle belongs to another install' } };
    store.remove(req.handle);
    return { status: 200, body: { ok: true, result: 'removed' } };
  }
  if (existing && existing.owner !== req.owner) return { status: 409, body: { error: 'handle already on the wall from another install' } };
  if (existing) return { status: 200, body: { ok: true, result: 'unchanged', handle: existing.handle } };
  const mine = store.byOwner(req.owner);
  if (mine) store.remove(mine.handle);
  if (!mine && store.list().length >= FOUNDER_CAP) return { status: 403, body: { error: 'the founding wall is full' } };
  store.put({ handle: req.handle, owner: req.owner, added_at: mine?.added_at ?? now });
  return { status: 201, body: { ok: true, result: mine ? 'replaced' : 'added', handle: req.handle } };
}
