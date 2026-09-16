import { spawn } from 'node:child_process';

// Hand a file to whatever the OS uses to open it. Detached and fully
// redirected, so the viewer outlives the CLI and nothing it prints lands in
// the terminal. Opening a report is a convenience: it must never be the
// reason the command fails, so every failure path returns false quietly.

function opener(platform: NodeJS.Platform): { cmd: string; args: string[] } | null {
  if (platform === 'darwin') return { cmd: 'open', args: [] };
  if (platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', ''] };
  if (platform === 'linux' || platform === 'freebsd' || platform === 'openbsd') return { cmd: 'xdg-open', args: [] };
  return null;
}

/** Open `path` in the OS default application. Returns false if it could not try. */
export function openPath(path: string, platform: NodeJS.Platform = process.platform): boolean {
  const o = opener(platform);
  if (!o) return false;
  try {
    const child = spawn(o.cmd, [...o.args, path], { detached: true, stdio: 'ignore', windowsHide: true });
    // A missing `xdg-open` arrives as an async 'error' event, which is an
    // unhandled throw on the process unless it is caught here.
    child.on('error', () => { /* no opener on this box; the path was printed */ });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
