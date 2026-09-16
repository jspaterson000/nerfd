#!/usr/bin/env node
// Builds dist/nerfd.tgz: the three packages plus the workspace links
// node needs to resolve @nerfd/* without an install step. No bundler,
// no transpile; the tarball is the source.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const stage = join(root, 'dist', 'stage');
const out = join(root, 'dist', 'nerfd.tgz');

rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, 'packages'), { recursive: true });
for (const p of ['core', 'cli', 'server']) {
  cpSync(join(root, 'packages', p), join(stage, 'packages', p), {
    recursive: true,
    filter: (src) => !src.includes('node_modules') && !src.endsWith('.db') && !/\/test\//.test(src),
  });
}
// Relative symlinks so the archive works wherever it is extracted.
for (const p of ['cli', 'server']) {
  const nm = join(stage, 'packages', p, 'node_modules', '@nerfd');
  mkdirSync(nm, { recursive: true });
  symlinkSync('../../../core', join(nm, 'core'));
  if (p === 'cli') symlinkSync('../../../server', join(nm, 'server'));
}
cpSync(join(root, 'README.md'), join(stage, 'README.md'));
writeFileSync(join(stage, 'VERSION'), JSON.parse(execFileSync('cat', [join(root, 'package.json')], { encoding: 'utf8' })).version + '\n');

execFileSync('tar', ['-czf', out, '-C', stage, '.']);
rmSync(stage, { recursive: true, force: true });
process.stdout.write(`wrote ${out}\n`);
