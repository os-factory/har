import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findPreferredLocalRuntime } from '../src/core/prefer-local-runtime';

function writeHarPackage(dir: string, version: string, entryRel = 'dist/index.js'): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify(
      {
        name: '@osfactory/har',
        version,
        bin: { har: entryRel },
      },
      null,
      2,
    ) + '\n',
  );
  const entry = path.join(dir, entryRel);
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, '#!/usr/bin/env node\n');
  return entry;
}

describe('findPreferredLocalRuntime (#344)', () => {
  it('prefers a newer HAR checkout over the running CLI', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'har-prefer-repo-'));
    const entry = writeHarPackage(root, '1.8.0');
    const found = findPreferredLocalRuntime({
      cwd: root,
      currentVersion: '1.0.0',
      currentEntry: '/usr/lib/node_modules/@osfactory/har/dist/index.js',
    });
    expect(found).toEqual({ entryPath: entry, version: '1.8.0', reason: 'har-repo' });
  });

  it('prefers a newer node_modules/@osfactory/har', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'har-prefer-nm-'));
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'app', version: '1.0.0' }, null, 2) + '\n',
    );
    const nested = path.join(root, 'node_modules', '@osfactory', 'har');
    const entry = writeHarPackage(nested, '1.9.0');
    const found = findPreferredLocalRuntime({
      cwd: path.join(root, 'src'),
      currentVersion: '1.0.0',
    });
    expect(found).toEqual({ entryPath: entry, version: '1.9.0', reason: 'node_modules' });
  });

  it('does not prefer an older or equal local runtime', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'har-prefer-older-'));
    writeHarPackage(root, '1.0.0');
    expect(
      findPreferredLocalRuntime({
        cwd: root,
        currentVersion: '1.8.0',
      }),
    ).toBeNull();
    expect(
      findPreferredLocalRuntime({
        cwd: root,
        currentVersion: '1.0.0',
      }),
    ).toBeNull();
  });

  it('does not re-select the currently running entry', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'har-prefer-self-'));
    const entry = writeHarPackage(root, '1.8.0');
    expect(
      findPreferredLocalRuntime({
        cwd: root,
        currentVersion: '1.0.0',
        currentEntry: entry,
      }),
    ).toBeNull();
  });
});
