import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  getOnboardingPreferencesPath,
  readOnboardingPreferences,
  writeOnboardingPreferences,
} from '../src/core/onboarding-preferences';

describe('onboarding preferences', () => {
  let tmpDir: string;
  let preferencePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-preferences-'));
    preferencePath = path.join(tmpDir, 'preferences.json');
    process.env.HAR_PREFERENCES_PATH = preferencePath;
  });

  afterEach(() => {
    delete process.env.HAR_PREFERENCES_PATH;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns safe defaults when no preference file exists', () => {
    expect(getOnboardingPreferencesPath()).toBe(preferencePath);
    expect(readOnboardingPreferences()).toMatchObject({
      version: 1,
      cursorRule: 'auto',
      agentSkills: 'auto',
      commitGate: {
        install: 'prompt',
        mode: 'block',
        scope: 'worktrees',
      },
    });
  });

  it('persists partial updates without losing existing choices', () => {
    writeOnboardingPreferences({
      cursorRule: 'off',
      agentSkills: ['cursor'],
      commitGateInstall: 'always',
    });
    const updated = writeOnboardingPreferences({
      commitGateMode: 'warn',
      commitGateScope: 'all',
    });

    expect(updated).toMatchObject({
      cursorRule: 'off',
      agentSkills: ['cursor'],
      commitGate: {
        install: 'always',
        mode: 'warn',
        scope: 'all',
      },
    });
    expect(updated.updatedAt).toBeDefined();
  });

  it('falls back to defaults for malformed files', () => {
    fs.writeFileSync(preferencePath, '{not-json');
    expect(readOnboardingPreferences().commitGate.mode).toBe('block');
  });
});
