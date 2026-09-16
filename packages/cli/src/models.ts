import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelRef } from '@nerfd/core';
import { ensureHome, HOME } from './paths.ts';

// User declarations for models nothing else can resolve: a local runtime the
// person named themselves, a merge they made, weights with no public id.
// `nerfd model-info` writes here and every later session re-applies it.

export const MODELS_PATH = join(HOME, 'models.json');

export type Declarations = Record<string, Partial<ModelRef>>;

export function loadDeclarations(): Declarations {
  try {
    if (!existsSync(MODELS_PATH)) return {};
    const raw = JSON.parse(readFileSync(MODELS_PATH, 'utf8')) as { models?: Declarations } | Declarations;
    const models = (raw as { models?: Declarations }).models ?? (raw as Declarations);
    return models && typeof models === 'object' ? models : {};
  } catch {
    return {}; // a broken declarations file must never break capture
  }
}

export function saveDeclarations(d: Declarations): void {
  ensureHome();
  writeFileSync(MODELS_PATH, JSON.stringify({ models: d }, null, 2) + '\n', { mode: 0o600 });
}
