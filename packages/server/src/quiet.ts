// node:sqlite still prints an ExperimentalWarning on load. It is stable
// enough for a local cache, and a hook must not spray stderr into the host
// tool, so drop that one warning and nothing else.
const original = process.emitWarning.bind(process);
(process as { emitWarning: typeof process.emitWarning }).emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === 'string' ? warning : warning?.message ?? '';
  if (/SQLite is an experimental feature/i.test(text)) return;
  (original as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;
export {};
