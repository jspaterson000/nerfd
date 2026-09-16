// Minimal argv parser. `--key value`, `--key=value`, `--flag`, `-n 5`, and
// positionals. No dependency, no magic.
export interface Args { _: string[]; [k: string]: string | boolean | string[] | undefined }

export function parseArgs(argv: string[]): Args {
  const out: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') { out._.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next != null && !next.startsWith('-')) { out[key] = next; i++; } else out[key] = true;
      continue;
    }
    if (/^-[a-zA-Z]$/.test(a)) {
      const key = a.slice(1);
      const next = argv[i + 1];
      if (next != null && !next.startsWith('-')) { out[key] = next; i++; } else out[key] = true;
      continue;
    }
    out._.push(a);
  }
  return out;
}

export function str(a: Args, k: string, fallback?: string): string | undefined {
  const v = a[k];
  return typeof v === 'string' ? v : fallback;
}

export function num(a: Args, k: string, fallback: number): number {
  const v = a[k];
  const n = typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

export function flag(a: Args, k: string): boolean {
  return a[k] === true || a[k] === 'true';
}
