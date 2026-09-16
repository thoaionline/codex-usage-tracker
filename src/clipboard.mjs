import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function copyAuthJson({
  codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
  signal,
  writeClipboard = copyToClipboard,
} = {}) {
  let json;
  try {
    json = await readFile(path.join(codexHome, 'auth.json'), 'utf8');
  } catch {
    throw new Error('Cannot read auth.json in the active Codex home.');
  }
  try {
    const value = JSON.parse(json);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
  } catch {
    throw new Error('auth.json does not contain a valid JSON object.');
  }
  await writeClipboard(json, { signal });
}

export async function copyToClipboard(text, {
  signal, platform = process.platform, env = process.env,
} = {}) {
  const commands = platform === 'darwin' ? [['pbcopy']] : platform === 'win32'
    ? [['clip.exe']] : [
      ...(env.WAYLAND_DISPLAY ? [['wl-copy']] : []),
      ...(env.DISPLAY ? [['xclip', '-selection', 'clipboard'], ['xsel', '--clipboard', '--input']] : []),
    ];
  for (const [command, ...args] of commands) {
    signal?.throwIfAborted();
    try {
      await new Promise((resolve, reject) => {
        const child = execFile(command, args, {
          env, signal, timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 1024,
        }, error => error ? reject(error) : resolve());
        child.stdin.on('error', reject);
        child.stdin.end(text);
      });
      return;
    } catch {
      // Clipboard utilities may echo input on failure; never expose their errors.
      signal?.throwIfAborted();
    }
  }
  throw new Error('Clipboard unavailable. Use pbcopy (macOS), clip.exe (Windows), or wl-copy/xclip/xsel in a Linux desktop session.');
}
