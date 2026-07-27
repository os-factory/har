import { spawnSync } from 'child_process';
import {
  copyTextToClipboard,
  writeOsc52Clipboard,
} from '../src/utils/clipboard';
import { offerAdaptationPromptClipboard } from '../src/harness/adaptation-prompt';

jest.mock('child_process', () => {
  const actual = jest.requireActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawnSync: jest.fn(),
  };
});

const mockedSpawnSync = spawnSync as jest.MockedFunction<typeof spawnSync>;

describe('clipboard', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    mockedSpawnSync.mockReset();
    jest.restoreAllMocks();
  });

  it('writeOsc52Clipboard writes base64 OSC 52 when stream is a TTY', () => {
    const chunks: string[] = [];
    const stream = {
      isTTY: true,
      write: (chunk: string) => {
        chunks.push(chunk);
        return true;
      },
    };

    expect(writeOsc52Clipboard('hello', stream as unknown as NodeJS.WriteStream)).toBe(true);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatch(/^\x1b]52;c;[A-Za-z0-9+/=]+\x07$/);
    expect(Buffer.from(chunks[0].slice('\x1b]52;c;'.length, -1), 'base64').toString('utf8')).toBe(
      'hello',
    );
  });

  it('writeOsc52Clipboard returns false when stream is not a TTY', () => {
    const stream = { isTTY: false, write: jest.fn() };
    expect(writeOsc52Clipboard('hello', stream as unknown as NodeJS.WriteStream)).toBe(false);
    expect(stream.write).not.toHaveBeenCalled();
  });

  it('copyTextToClipboard uses pbcopy on macOS', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    mockedSpawnSync.mockImplementation((command, args) => {
      if (command === 'which' && Array.isArray(args) && args[0] === 'pbcopy') {
        return { status: 0, error: undefined } as ReturnType<typeof spawnSync>;
      }
      if (command === 'pbcopy') {
        return { status: 0, error: undefined } as ReturnType<typeof spawnSync>;
      }
      return { status: 1, error: undefined } as ReturnType<typeof spawnSync>;
    });

    expect(copyTextToClipboard('adapt me')).toEqual({ ok: true, method: 'pbcopy' });
    expect(mockedSpawnSync).toHaveBeenCalledWith(
      'pbcopy',
      [],
      expect.objectContaining({ input: 'adapt me' }),
    );
  });

  it('copyTextToClipboard prefers wl-copy on Linux', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    mockedSpawnSync.mockImplementation((command, args) => {
      if (command === 'which' && Array.isArray(args) && args[0] === 'wl-copy') {
        return { status: 0, error: undefined } as ReturnType<typeof spawnSync>;
      }
      if (command === 'wl-copy') {
        return { status: 0, error: undefined } as ReturnType<typeof spawnSync>;
      }
      return { status: 1, error: undefined } as ReturnType<typeof spawnSync>;
    });

    expect(copyTextToClipboard('linux prompt')).toEqual({ ok: true, method: 'wl-copy' });
  });

  it('copyTextToClipboard falls back to OSC 52 when no clipboard tool exists', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    mockedSpawnSync.mockReturnValue({ status: 1, error: undefined } as ReturnType<typeof spawnSync>);

    const write = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    Object.defineProperty(process.stderr, 'isTTY', { configurable: true, value: true });

    expect(copyTextToClipboard('remote ssh')).toEqual({ ok: true, method: 'osc52' });
    expect(write).toHaveBeenCalledWith(expect.stringMatching(/^\x1b]52;c;/));

    write.mockRestore();
    Object.defineProperty(process.stderr, 'isTTY', { configurable: true, value: process.stderr.isTTY });
  });
});

describe('offerAdaptationPromptClipboard', () => {
  const originalStdinIsTTY = process.stdin.isTTY;
  const originalStderrIsTTY = process.stderr.isTTY;

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: originalStdinIsTTY });
    Object.defineProperty(process.stderr, 'isTTY', { configurable: true, value: originalStderrIsTTY });
    jest.restoreAllMocks();
  });

  it('skips when not a TTY and autoYes is false', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
    Object.defineProperty(process.stderr, 'isTTY', { configurable: true, value: false });

    const copied = await offerAdaptationPromptClipboard('prompt body');
    expect(copied).toBe(false);
  });

  it('auto-copies with --yes without prompting', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
    Object.defineProperty(process.stderr, 'isTTY', { configurable: true, value: true });

    mockedSpawnSync.mockImplementation((command, args) => {
      if (process.platform === 'darwin') {
        if (command === 'which' && Array.isArray(args) && args[0] === 'pbcopy') {
          return { status: 0, error: undefined } as ReturnType<typeof spawnSync>;
        }
        if (command === 'pbcopy') {
          return { status: 0, error: undefined } as ReturnType<typeof spawnSync>;
        }
      }
      if (process.platform === 'linux') {
        if (
          command === 'which' &&
          Array.isArray(args) &&
          (args[0] === 'wl-copy' || args[0] === 'xclip' || args[0] === 'xsel')
        ) {
          return { status: 0, error: undefined } as ReturnType<typeof spawnSync>;
        }
        if (command === 'wl-copy' || command === 'xclip' || command === 'xsel') {
          return { status: 0, error: undefined } as ReturnType<typeof spawnSync>;
        }
      }
      if (process.platform === 'win32') {
        if (command === 'where' && Array.isArray(args) && args[0] === 'powershell') {
          return { status: 0, error: undefined } as ReturnType<typeof spawnSync>;
        }
        if (command === 'powershell') {
          return { status: 0, error: undefined } as ReturnType<typeof spawnSync>;
        }
      }
      return { status: 1, error: undefined } as ReturnType<typeof spawnSync>;
    });

    const write = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const copied = await offerAdaptationPromptClipboard('prompt body', { autoYes: true });
    expect(copied).toBe(true);
    write.mockRestore();
  });
});
