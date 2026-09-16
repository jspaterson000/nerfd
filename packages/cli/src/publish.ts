import { toReport, validateReport } from '@nerfd/core';
import type { Session } from '@nerfd/core';
import { putSession } from './db.ts';
import { CLIENT_VERSION, loadConfig, log, type Config } from './paths.ts';

// The one and only path by which data leaves the machine. Used by
// `nerfd share`, by the SessionEnd hook when sharing is on, and by `nerfd rate`
// to update a record that was already sent.

export async function publishSession(s: Session, cfg: Config = loadConfig(), evidenceUrl: string | null = null, timeoutMs = 6000): Promise<{ ok: boolean; reason?: string }> {
  if (s.metrics.prompts === 0 && s.duration_s != null && s.duration_s < 60) return { ok: false, reason: 'empty session' };
  const r = toReport(s, cfg.install_id, CLIENT_VERSION, evidenceUrl);
  if (!r) return { ok: false, reason: 'not finished or no model' };
  const err = validateReport(r);
  if (err) return { ok: false, reason: err };
  try {
    const res = await fetch(`${cfg.server}/v1/reports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(r),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, reason: `server ${res.status}: ${(await res.text()).slice(0, 200)}` };
    s.shared_at = new Date().toISOString();
    putSession(s);
    return { ok: true };
  } catch (e) {
    log(`publish ${s.id}: ${(e as Error).message}`);
    return { ok: false, reason: (e as Error).message };
  }
}
