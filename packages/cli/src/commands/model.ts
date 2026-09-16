import { registerModelDeclarations, resolveModelRef, probeLocalModel, type ModelRef } from '@nerfd/core';
import { flag, str, type Args } from '../args.ts';
import { loadDeclarations, saveDeclarations, MODELS_PATH } from '../models.ts';

/**
 * `nerfd model-info <raw_id> [--family qwen3-coder --version 2507 --size 27B
 *                            --quant awq-int4 --provider vllm-self --modified]`
 *
 * With no flags it prints what the resolver currently makes of an id, which
 * is the fastest way to find out whether a declaration is needed at all.
 * With flags it records the answer and every later session re-uses it.
 */
export async function modelInfo(a: Args): Promise<void> {
  const rawId = a._[0];
  if (!rawId) {
    const declared = loadDeclarations();
    const ids = Object.keys(declared);
    process.stdout.write(
      ids.length
        ? `declared models (${MODELS_PATH}):\n` + ids.map((id) => `  ${id}  ${JSON.stringify(declared[id])}`).join('\n') + '\n'
        : 'usage: nerfd model-info <raw_id> [--family X --version X --size 27B --quant awq-int4 --provider X --modified]\n',
    );
    return;
  }

  const fields: Partial<ModelRef> = {};
  for (const k of ['family', 'version', 'size', 'quant', 'provider'] as const) {
    const v = str(a, k);
    if (v) fields[k] = v;
  }
  const mode = str(a, 'serving-mode');
  if (mode === 'hosted' || mode === 'plan' || mode === 'local') fields.serving_mode = mode;
  if (flag(a, 'modified')) fields.modified = true;
  if (flag(a, 'not-modified')) fields.modified = false;

  const declared = loadDeclarations();
  if (Object.keys(fields).length > 0) {
    declared[rawId] = { ...declared[rawId], ...fields };
    saveDeclarations(declared);
  }

  // A probe beats a declaration for anything the runtime will answer for.
  const baseUrl = str(a, 'base-url');
  if (baseUrl) {
    const probe = await probeLocalModel(baseUrl);
    process.stdout.write(probe ? `probe    ${probe.provider}: ${probe.models.join(', ')}${probe.quant ? ` quant=${probe.quant}` : ''}\n` : `probe    ${baseUrl}: no answer\n`);
  }

  registerModelDeclarations(declared);
  const ref = resolveModelRef(rawId, str(a, 'raw-provider') ?? null, { baseUrl, declaredName: str(a, 'name') });
  process.stdout.write(
    [
      `raw      ${ref.raw_id}${ref.raw_provider ? ` (${ref.raw_provider})` : ''}`,
      `family   ${ref.family ?? '-'}${ref.version ? ` ${ref.version}` : ''}${ref.size ? ` ${ref.size}` : ''}`,
      `quant    ${ref.quant}${ref.modified ? '  (modified weights: kept out of family tiers)' : ''}`,
      `served   ${ref.provider ?? '-'} / ${ref.serving_mode}${ref.variant ? ` / ${ref.variant}` : ''}`,
      Object.keys(fields).length ? `saved    ${MODELS_PATH}` : 'note     nothing declared; run again with --family/--size/--quant to override',
      '',
    ].join('\n'),
  );
}
