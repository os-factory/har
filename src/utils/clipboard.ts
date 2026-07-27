import { spawnSync } from 'child_process';

export type ClipboardMethod =
  | 'pbcopy'
  | 'wl-copy'
  | 'xclip'
  | 'xsel'
  | 'clip'
  | 'powershell'
  | 'osc52';

export type ClipboardResult =
  | { ok: true; method: ClipboardMethod }
  | { ok: false; detail: string };

function commandExists(command: string): boolean {
  const probe =
    process.platform === 'win32'
      ? spawnSync('where', [command], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'ignore'] })
      : spawnSync('which', [command], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'ignore'] });
  return probe.status === 0;
}

function tryPipeCommand(command: string, args: string[], text: string): boolean {
  const result = spawnSync(command, args, {
    input: text,
    encoding: 'utf8',
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  return result.status === 0 && !result.error;
}

/** OSC 52 — works in many modern terminals (incl. remote SSH) when the emulator allows it. */
export function writeOsc52Clipboard(text: string, stream: NodeJS.WritableStream = process.stderr): boolean {
  if (!('isTTY' in stream) || !(stream as NodeJS.WriteStream).isTTY) return false;
  // Soft cap: some terminals truncate large OSC 52 payloads.
  if (Buffer.byteLength(text, 'utf8') > 200_000) return false;
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  stream.write(`\x1b]52;c;${b64}\x07`);
  return true;
}

function copyViaPlatformTools(text: string): ClipboardResult {
  if (process.platform === 'darwin' && commandExists('pbcopy')) {
    if (tryPipeCommand('pbcopy', [], text)) return { ok: true, method: 'pbcopy' };
  }

  if (process.platform === 'win32') {
    // Prefer stdin over -Command string args (adaptation prompts can exceed cmd length limits).
    if (commandExists('powershell')) {
      const result = spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '$OutputEncoding = [Console]::InputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new(); Set-Clipboard -Value ([Console]::In.ReadToEnd())',
        ],
        {
          input: text,
          encoding: 'utf8',
          stdio: ['pipe', 'ignore', 'ignore'],
        },
      );
      if (result.status === 0 && !result.error) return { ok: true, method: 'powershell' };
    }
    if (commandExists('clip') && tryPipeCommand('clip', [], text)) {
      return { ok: true, method: 'clip' };
    }
  }

  if (process.platform === 'linux' || process.platform === 'freebsd' || process.platform === 'openbsd') {
    if (commandExists('wl-copy') && tryPipeCommand('wl-copy', [], text)) {
      return { ok: true, method: 'wl-copy' };
    }
    if (commandExists('xclip') && tryPipeCommand('xclip', ['-selection', 'clipboard'], text)) {
      return { ok: true, method: 'xclip' };
    }
    if (commandExists('xsel') && tryPipeCommand('xsel', ['--clipboard', '--input'], text)) {
      return { ok: true, method: 'xsel' };
    }
  }

  return {
    ok: false,
    detail: 'No system clipboard command available (pbcopy, wl-copy/xclip/xsel, or clip)',
  };
}

/**
 * Copy text to the system clipboard when possible.
 * Prefers native clipboard tools; falls back to OSC 52 for TTY terminals (incl. SSH).
 */
export function copyTextToClipboard(text: string): ClipboardResult {
  const platform = copyViaPlatformTools(text);
  if (platform.ok) return platform;

  if (writeOsc52Clipboard(text)) {
    return { ok: true, method: 'osc52' };
  }

  return platform;
}
