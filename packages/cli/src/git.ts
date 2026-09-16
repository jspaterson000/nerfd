import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hashLine, type RepoProfile, type Size } from '@nerfd/core';

function git(cwd: string, args: string[], maxBuffer = 16 * 1024 * 1024): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000, maxBuffer }).trim();
  } catch {
    return null;
  }
}

export function isRepo(cwd: string): boolean {
  return git(cwd, ['rev-parse', '--is-inside-work-tree']) === 'true';
}

export function head(cwd: string): string | null {
  return git(cwd, ['rev-parse', 'HEAD']);
}

export function branch(cwd: string): string | null {
  return git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

const LANG_MARKERS: Array<[string, string[]]> = [
  ['ts', ['tsconfig.json']],
  ['js', ['package.json']],
  ['py', ['pyproject.toml', 'setup.py', 'requirements.txt']],
  ['go', ['go.mod']],
  ['rs', ['Cargo.toml']],
  ['swift', ['Package.swift']],
  ['java', ['pom.xml', 'build.gradle', 'build.gradle.kts']],
  ['rb', ['Gemfile']],
  ['php', ['composer.json']],
  ['cs', ['global.json']],
  ['ex', ['mix.exs']],
];

export function repoProfile(cwd: string): RepoProfile {
  if (!isRepo(cwd)) return { lang: detectLang(cwd), size: 's', age: 'unknown' };
  const root = git(cwd, ['rev-parse', '--show-toplevel']) ?? cwd;
  const files = git(root, ['ls-files']) ?? '';
  const count = files ? files.split('\n').length : 0;
  const size: Size = count >= 2000 ? 'l' : count >= 200 ? 'm' : 's';

  const firstCommitTs = git(root, ['log', '--reverse', '--format=%ct', '--max-count=1']);
  const commits = Number(git(root, ['rev-list', '--count', 'HEAD']) ?? 0);
  let age: RepoProfile['age'] = 'unknown';
  if (firstCommitTs) {
    const days = (Date.now() / 1000 - Number(firstCommitTs)) / 86400;
    age = days < 30 || commits < 50 ? 'greenfield' : 'established';
  }
  return { lang: detectLang(root, files), size, age };
}

function detectLang(root: string, tracked = ''): string {
  const found: string[] = [];
  for (const [lang, markers] of LANG_MARKERS) {
    if (markers.some((m) => existsSync(join(root, m)))) found.push(lang);
  }
  // package.json + tsconfig.json => just ts
  if (found.includes('ts') && found.includes('js')) found.splice(found.indexOf('js'), 1);
  if (found.length === 0 && tracked) {
    const ext: Record<string, number> = {};
    for (const f of tracked.split('\n')) {
      const m = /\.([a-z0-9]+)$/i.exec(f);
      if (m) ext[m[1]!.toLowerCase()] = (ext[m[1]!.toLowerCase()] ?? 0) + 1;
    }
    const top = Object.entries(ext).sort((a, b) => b[1] - a[1])[0];
    if (top) return top[0];
    return 'none';
  }
  if (found.length === 0) return 'none';
  if (found.length === 1) return found[0]!;
  return 'mixed';
}

/**
 * Hashes of every added line in the working tree relative to HEAD, plus
 * every line of untracked files. Capped so a stray build artefact cannot
 * blow up the record.
 */
export function addedLineHashes(cwd: string, salt = '', cap = 20000): string[] {
  if (!isRepo(cwd)) return [];
  const root = git(cwd, ['rev-parse', '--show-toplevel']) ?? cwd;
  const out = new Set<string>();

  const diff = git(root, ['diff', 'HEAD', '--no-color', '--unified=0', '--no-ext-diff', '--', '.']) ?? '';
  let file = '';
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) { file = line.slice(4).replace(/^b\//, ''); continue; }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      const content = line.slice(1);
      if (content.trim().length < 3) continue;
      out.add(hashLine(file, content, salt));
      if (out.size >= cap) return [...out];
    }
  }

  const untracked = git(root, ['ls-files', '--others', '--exclude-standard']) ?? '';
  for (const f of untracked.split('\n').filter(Boolean)) {
    if (/(\.lock|\.min\.|\.map|\.png|\.jpg|\.gif|\.pdf|\.db|node_modules\/)/.test(f)) continue;
    try {
      const text = readFileSync(join(root, f), 'utf8');
      if (text.length > 512 * 1024) continue;
      for (const l of text.split('\n')) {
        if (l.trim().length < 3) continue;
        out.add(hashLine(f, l, salt));
        if (out.size >= cap) return [...out];
      }
    } catch { /* binary or unreadable */ }
  }
  return [...out];
}

/** How many of `hashes` still exist somewhere in the current working tree? */
export function survivingCount(cwd: string, hashes: string[], salt = ''): number | null {
  if (!isRepo(cwd) || hashes.length === 0) return null;
  const root = git(cwd, ['rev-parse', '--show-toplevel']) ?? cwd;
  const want = new Set(hashes);
  // We only need to re-hash files that could contain these lines. The hash
  // includes the path, so re-scan tracked + untracked files and intersect.
  const files = [
    ...(git(root, ['ls-files']) ?? '').split('\n'),
    ...(git(root, ['ls-files', '--others', '--exclude-standard']) ?? '').split('\n'),
  ].filter(Boolean);
  let hits = 0;
  for (const f of files) {
    if (/(\.lock|\.min\.|\.map|\.png|\.jpg|\.gif|\.pdf|\.db|node_modules\/)/.test(f)) continue;
    let text: string;
    try { text = readFileSync(join(root, f), 'utf8'); } catch { continue; }
    if (text.length > 512 * 1024) continue;
    for (const l of text.split('\n')) {
      if (l.trim().length < 3) continue;
      const h = hashLine(f, l, salt);
      if (want.has(h)) { hits++; want.delete(h); }
    }
    if (want.size === 0) break;
  }
  return hits;
}
