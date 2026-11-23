import * as fs from 'fs';
import * as path from 'path';
import {
  pm2Argv,
  pm2Command,
  resetPm2CommandCache,
  resolveBundledPm2,
  resolvePm2Argv,
} from '../src/utils/pm2';

describe('resolvePm2Argv', () => {
  it('runs the bundled pm2 through the current runtime when it resolves', () => {
    const commandExists = jest.fn(() => true);
    const packageRunner = jest.fn(() => 'npx --yes');
    const argv = resolvePm2Argv({
      resolveBundled: () => '/opt/har/node_modules/pm2/bin/pm2',
      execPath: '/usr/bin/node',
      commandExists,
      packageRunner,
    });
    expect(argv).toEqual(['/usr/bin/node', '/opt/har/node_modules/pm2/bin/pm2']);
    expect(commandExists).not.toHaveBeenCalled();
    expect(packageRunner).not.toHaveBeenCalled();
  });

  it('defaults the runtime to process.execPath (node or bun)', () => {
    expect(resolvePm2Argv({ resolveBundled: () => '/x/pm2/bin/pm2' })).toEqual([
      process.execPath,
      '/x/pm2/bin/pm2',
    ]);
  });

  it('falls back to pm2 on PATH when the bundled copy cannot be resolved', () => {
    const packageRunner = jest.fn(() => 'npx --yes');
    const argv = resolvePm2Argv({
      resolveBundled: () => undefined,
      commandExists: (cmd) => cmd === 'pm2',
      packageRunner,
    });
    expect(argv).toEqual(['pm2']);
    expect(packageRunner).not.toHaveBeenCalled();
  });

  it.each([
    ['npx --yes', ['npx', '--yes', 'pm2']],
    ['bunx', ['bunx', 'pm2']],
    ['pnpm dlx', ['pnpm', 'dlx', 'pm2']],
  ])('falls back to the package runner %s last', (runner, expected) => {
    const argv = resolvePm2Argv({
      resolveBundled: () => undefined,
      commandExists: () => false,
      packageRunner: () => runner,
    });
    expect(argv).toEqual(expected);
  });
});

describe('resolveBundledPm2', () => {
  it('finds the pm2 CLI shipped as a dependency', () => {
    const bin = resolveBundledPm2();
    expect(bin).toBeDefined();
    expect(bin!.split(path.sep).slice(-3)).toEqual(['pm2', 'bin', 'pm2']);
    expect(fs.existsSync(bin!)).toBe(true);
  });
});

describe('pm2Command', () => {
  afterEach(() => resetPm2CommandCache());

  it('memoizes the argv and renders a shell-safe command line', () => {
    resetPm2CommandCache();
    const first = pm2Argv();
    first.push('mutated');
    expect(pm2Argv()).not.toContain('mutated');
    expect(pm2Command()).toBe(pm2Argv().map((a) => (/\s/.test(a) ? `'${a}'` : a)).join(' '));
  });
});
