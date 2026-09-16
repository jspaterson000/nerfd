import { readFileSync } from 'node:fs';

// A deliberately tiny YAML reader. Goose's `config.yaml` is the only YAML this
// project reads, we need six keys out of it, and the repo has zero runtime
// dependencies. It understands exactly what the documented shape uses:
// indentation-nested mappings of scalars. Sequences, anchors, flow style and
// multi-line scalars are skipped rather than guessed at.
//
//   active_provider: anthropic
//   providers:
//     anthropic:
//       enabled: true
//       model: claude-sonnet-4-5-20250929
//
// Anything that looks like a credential is dropped while parsing, so a secret
// cannot reach a variable, a log line or a crash trace. Goose keeps real
// secrets in `secrets.yaml` or the OS keyring, which this never opens.

export type YamlNode = string | YamlMap;
export interface YamlMap { [k: string]: YamlNode }

const SECRETISH = /(key|token|secret|password|passwd|credential|auth|cookie|session_token)/i;

function unquote(v: string): string {
  const s = v.trim();
  if (s.length >= 2 && ((s[0] === '"' && s.at(-1) === '"') || (s[0] === "'" && s.at(-1) === "'"))) {
    return s.slice(1, -1);
  }
  // An unquoted scalar runs to a ` #` comment.
  const hash = s.indexOf(' #');
  return (hash >= 0 ? s.slice(0, hash) : s).trim();
}

/** Parse the subset described above. Never throws. */
export function parseSimpleYaml(text: string): YamlMap {
  const root: YamlMap = {};
  // Stack of (indent, map) frames. The root sits at indent -1.
  const stack: Array<{ indent: number; map: YamlMap }> = [{ indent: -1, map: root }];

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\t/g, '  ');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (line.trim().startsWith('-')) continue;                  // sequences: not needed

    const indent = line.length - line.trimStart().length;
    const body = line.trim();
    const colon = body.indexOf(':');
    if (colon < 0) continue;

    const key = unquote(body.slice(0, colon));
    if (!key) continue;
    const value = body.slice(colon + 1).trim();

    while (stack.length > 1 && indent <= stack[stack.length - 1]!.indent) stack.pop();
    const parent = stack[stack.length - 1]!.map;

    if (SECRETISH.test(key)) continue;                          // never hold a credential

    if (value === '' || value === '|' || value === '>') {
      const child: YamlMap = {};
      parent[key] = child;
      stack.push({ indent, map: child });
    } else {
      parent[key] = unquote(value);
    }
  }
  return root;
}

export function readSimpleYaml(path: string): YamlMap {
  try {
    return parseSimpleYaml(readFileSync(path, 'utf8'));
  } catch {
    // A config we cannot read is a config we do not have. Never log the reason:
    // a parse error can quote the line it failed on.
    return {};
  }
}

export function yamlString(node: YamlNode | undefined): string | null {
  return typeof node === 'string' && node.trim() ? node.trim() : null;
}

export function yamlMap(node: YamlNode | undefined): YamlMap | null {
  return node && typeof node === 'object' ? node : null;
}
