import type { Tool } from '@nerfd/core';
import { claudeAdapter } from './claude.ts';
import { codexAdapter } from './codex.ts';
import { opencodeAdapter } from './opencode.ts';
import { gooseAdapter } from './goose.ts';
import { kimiAdapter } from './kimi.ts';
import { geminiAdapter } from './gemini.ts';
import { qwenAdapter } from './qwen.ts';
import { crushAdapter } from './crush.ts';
import { clineAdapter } from './cline.ts';
import { aiderAdapter } from './aider.ts';
import { copilotAdapter } from './copilot.ts';
import type { Adapter } from './types.ts';

// Every tool nerfd can capture. Adding one is: write the adapter, add it
// here. `nerfd init` installs whichever ones it finds, `nerfd hook <id>`
// routes to them, and everything downstream is tool-agnostic.
export const ADAPTERS: Adapter[] = [
  claudeAdapter, codexAdapter, opencodeAdapter, gooseAdapter, kimiAdapter,
  geminiAdapter, qwenAdapter, crushAdapter, clineAdapter, aiderAdapter, copilotAdapter,
];

// What the hook command line says, which is not always the adapter id.
const ALIASES: Record<string, Tool> = {
  claude: 'claude-code',
  'claude-code': 'claude-code',
  codex: 'codex',
  opencode: 'opencode',
  oc: 'opencode',
  goose: 'goose',
  kimi: 'kimi',
  'kimi-code': 'kimi',
  gemini: 'gemini',
  qwen: 'qwen',
  'qwen-code': 'qwen',
  crush: 'crush',
  cline: 'cline',
  aider: 'aider',
  copilot: 'copilot',
  'github-copilot': 'copilot',
  'copilot-cli': 'copilot',
};

export function adapterFor(id: string | null | undefined): Adapter | null {
  if (!id) return null;
  const key = id.trim().toLowerCase();
  const want = ALIASES[key] ?? key;
  return ADAPTERS.find((a) => a.id === want) ?? null;
}

export function installedAdapters(): Adapter[] {
  return ADAPTERS.filter((a) => a.detect());
}
