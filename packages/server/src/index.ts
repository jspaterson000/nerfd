import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateReport, type Report, type Row } from '@nerfd/core';
import { installScript } from './installer.ts';
import { landingPage } from './landing.ts';
import type { ReportStore } from './store.ts';
import { boardPage } from './ui.ts';

// Plain node:http. No framework, no middleware stack, nothing to audit but
// this file. The same server runs the public site and `nerfd dash`.

export interface ServerOptions {
  port: number;
  title: string;
  readOnly: boolean;
  store?: ReportStore;        // public mode
  rows?: () => Row[];         // local mode: rows come from the CLI's database
  maxPerReporterPerDay?: number;
  publicOrigin?: string;      // e.g. https://nerfd.dev; defaults to the request host
  distDir?: string;           // where dist/nerfd.tgz lives
}

import { queryData } from './queries.ts';
const DEFAULT_DIST = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'dist');
const ASSETS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets');

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(body));
}

function text(res: ServerResponse, status: number, body: string, type = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

async function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > limit) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function originOf(req: IncomingMessage, fallback?: string): string {
  if (fallback) return fallback;
  const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? 'http';
  const host = (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host ?? 'localhost';
  return `${proto}://${host}`;
}

export function startServer(o: ServerOptions) {
  const source = (weeks: number): Row[] => {
    if (o.rows) {
      const since = Date.now() - weeks * 7 * 86400 * 1000;
      return o.rows().filter((r) => Date.parse(r.ended_at) >= since);
    }
    return (o.store?.rows(weeks) ?? []).map((r): Row => ({ ...r, reporter: r.reporter_id }));
  };
  const distDir = o.distDir ?? DEFAULT_DIST;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const p = url.pathname;
    const origin = originOf(req, o.publicOrigin);
    try {
      if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
        if (o.readOnly) return text(res, 200, boardPage(o.title, true, origin), 'text/html; charset=utf-8');
        return text(res, 200, landingPage(origin), 'text/html; charset=utf-8');
      }
      if (req.method === 'GET' && p === '/board') return text(res, 200, boardPage(o.title, o.readOnly, origin), 'text/html; charset=utf-8');
      if (req.method === 'GET' && p === '/health') return json(res, 200, { ok: true, mode: o.readOnly ? 'local' : 'public' });

      if (req.method === 'GET' && p.startsWith('/assets/')) {
        // Static files (provider logos, fonts). Path is confined to the assets dir.
        const rel = p.slice('/assets/'.length).replace(/\.\./g, '');
        const f = join(ASSETS_DIR, rel);
        if (!f.startsWith(ASSETS_DIR) || !existsSync(f) || !statSync(f).isFile()) return text(res, 404, 'not found');
        const type = f.endsWith('.svg') ? 'image/svg+xml' : f.endsWith('.png') ? 'image/png' : f.endsWith('.woff2') ? 'font/woff2' : f.endsWith('.css') ? 'text/css' : f.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
        res.writeHead(200, { 'content-type': type, 'cache-control': 'public, max-age=86400' });
        return createReadStream(f).pipe(res);
      }
      if (req.method === 'GET' && p === '/privacy') {
        // Built by the privacy module; loaded lazily so the server runs without it.
        const modPath = './privacy.ts';
        const mod = (await import(modPath).catch(() => null)) as { privacyPage?: (o: string) => string } | null;
        if (!mod?.privacyPage) return text(res, 404, 'privacy page not built yet');
        return text(res, 200, mod.privacyPage(origin), 'text/html; charset=utf-8');
      }
      if (req.method === 'GET' && p === '/install.sh') {
        res.writeHead(200, { 'content-type': 'text/x-shellscript; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(installScript(origin));
      }
      if (req.method === 'GET' && p === '/dist/nerfd.tgz') {
        const f = join(distDir, 'nerfd.tgz');
        if (!existsSync(f)) return text(res, 404, 'release tarball not built. run: pnpm release');
        res.writeHead(200, { 'content-type': 'application/gzip', 'content-length': statSync(f).size, 'cache-control': 'no-store' });
        return createReadStream(f).pipe(res);
      }

      if (req.method === 'GET') {
        const data = queryData(url, source, o.readOnly, origin, o.store);
        if (data) return json(res, 200, data.body);
      }

      if (req.method === 'POST' && p === '/v1/reports') {
        if (o.readOnly || !o.store) return json(res, 405, { error: 'read-only' });
        const body = await readBody(req);
        let parsed: unknown;
        try { parsed = JSON.parse(body); } catch { return json(res, 400, { error: 'invalid json' }); }
        const err = validateReport(parsed);
        if (err) return json(res, 422, { error: err });
        const r = parsed as Report;
        const max = o.maxPerReporterPerDay ?? 200;
        if (o.store.recentFromReporter(r.reporter_id) >= max) return json(res, 429, { error: 'daily limit' });
        const result = o.store.insert(r);
        if (result === 'rejected') return json(res, 403, { error: 'report id belongs to another reporter' });
        return json(res, result === 'inserted' ? 201 : 200, { ok: true, result });
      }

      return text(res, 404, 'not found');
    } catch (e) {
      return json(res, 500, { error: (e as Error).message });
    }
  });
  server.listen(o.port);
  return server;
}

export { ReportStore } from './store.ts';
