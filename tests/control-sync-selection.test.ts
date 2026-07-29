import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.mock('../src/core/control-repo-path', () => ({
  canonicalizeControlRepoPath: (p: string) => p,
}));

import {
  getSyncSelectionPath,
  readSyncSelection,
  resolveSyncSelection,
  writeSyncSelection,
} from '../src/core/control-sync-selection';

describe('sync selection persistence', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'har-sync-selection-'));
    process.env.HAR_CONTROL_SYNC_SELECTION_PATH = path.join(tempHome, 'sync-selection.json');
  });

  afterEach(() => {
    delete process.env.HAR_CONTROL_SYNC_SELECTION_PATH;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('returns null before any selection is saved', () => {
    expect(readSyncSelection()).toBeNull();
  });

  it('round-trips a saved selection', () => {
    writeSyncSelection(['/repos/a', '/repos/b']);
    expect(fs.existsSync(getSyncSelectionPath())).toBe(true);
    expect(readSyncSelection()).toEqual(['/repos/a', '/repos/b']);
  });

  it('deduplicates repos on write', () => {
    writeSyncSelection(['/repos/a', '/repos/a', '/repos/b']);
    expect(readSyncSelection()).toEqual(['/repos/a', '/repos/b']);
  });

  it('returns null on malformed selection files', () => {
    fs.mkdirSync(path.dirname(getSyncSelectionPath()), { recursive: true });
    fs.writeFileSync(getSyncSelectionPath(), 'not json');
    expect(readSyncSelection()).toBeNull();
  });
});

describe('resolveSyncSelection', () => {
  it('prompts with all discovered pre-checked on first interactive run', () => {
    const result = resolveSyncSelection({
      discovered: ['/a', '/b'],
      stored: null,
      forceSelect: false,
      isTTY: true,
    });
    expect(result).toEqual({ needsPrompt: true, promptDefaults: ['/a', '/b'], toSync: [] });
  });

  it('syncs all discovered without prompting on first non-TTY run', () => {
    const result = resolveSyncSelection({
      discovered: ['/a', '/b'],
      stored: null,
      forceSelect: false,
      isTTY: false,
    });
    expect(result).toEqual({ needsPrompt: false, promptDefaults: [], toSync: ['/a', '/b'] });
  });

  it('syncs the stored selection silently when nothing changed', () => {
    const result = resolveSyncSelection({
      discovered: ['/a', '/b'],
      stored: ['/a', '/b'],
      forceSelect: false,
      isTTY: true,
    });
    expect(result).toEqual({ needsPrompt: false, promptDefaults: [], toSync: ['/a', '/b'] });
  });

  it('drops vanished repos from the stored selection', () => {
    const result = resolveSyncSelection({
      discovered: ['/a'],
      stored: ['/a', '/gone'],
      forceSelect: false,
      isTTY: false,
    });
    expect(result.toSync).toEqual(['/a']);
  });

  it('re-prompts when a new repo appears (stored + new pre-checked)', () => {
    const result = resolveSyncSelection({
      discovered: ['/a', '/b', '/c'],
      stored: ['/a'],
      forceSelect: false,
      isTTY: true,
    });
    expect(result).toEqual({ needsPrompt: true, promptDefaults: ['/a', '/b', '/c'], toSync: [] });
  });

  it('does not prompt for new repos when non-TTY (syncs stored only)', () => {
    const result = resolveSyncSelection({
      discovered: ['/a', '/b'],
      stored: ['/a'],
      forceSelect: false,
      isTTY: false,
    });
    expect(result).toEqual({ needsPrompt: false, promptDefaults: [], toSync: ['/a'] });
  });

  it('always prompts with --select, pre-checking the current selection', () => {
    const result = resolveSyncSelection({
      discovered: ['/a', '/b'],
      stored: ['/b'],
      forceSelect: true,
      isTTY: true,
    });
    expect(result).toEqual({ needsPrompt: true, promptDefaults: ['/b'], toSync: [] });
  });

  it('falls back to the stored set for --select without a TTY', () => {
    const result = resolveSyncSelection({
      discovered: ['/a', '/b'],
      stored: ['/b'],
      forceSelect: true,
      isTTY: false,
    });
    expect(result).toEqual({ needsPrompt: false, promptDefaults: [], toSync: ['/b'] });
  });
});
