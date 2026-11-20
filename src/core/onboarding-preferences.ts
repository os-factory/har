import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AgentSkillTarget,
  OnboardingPreferences,
  OnboardingPreferencesSchema,
} from '../harness/schema';

export interface OnboardingPreferenceOverrides {
  cursorRule?: 'auto' | 'on' | 'off';
  agentSkills?: 'auto' | AgentSkillTarget[];
  commitGateInstall?: 'prompt' | 'always' | 'never';
  commitGateMode?: 'block' | 'warn';
  commitGateScope?: 'worktrees' | 'all';
}

export function getOnboardingPreferencesPath(): string {
  if (process.env.HAR_PREFERENCES_PATH) {
    return path.resolve(process.env.HAR_PREFERENCES_PATH);
  }
  return path.join(os.homedir(), '.har', 'preferences.json');
}

export function readOnboardingPreferences(): OnboardingPreferences {
  const preferencePath = getOnboardingPreferencesPath();
  try {
    if (!fs.existsSync(preferencePath)) return OnboardingPreferencesSchema.parse({});
    return OnboardingPreferencesSchema.parse(JSON.parse(fs.readFileSync(preferencePath, 'utf8')));
  } catch {
    return OnboardingPreferencesSchema.parse({});
  }
}

export function mergeOnboardingPreferences(
  current: OnboardingPreferences,
  overrides: OnboardingPreferenceOverrides,
): OnboardingPreferences {
  return OnboardingPreferencesSchema.parse({
    ...current,
    cursorRule: overrides.cursorRule ?? current.cursorRule,
    agentSkills: overrides.agentSkills ?? current.agentSkills,
    commitGate: {
      ...current.commitGate,
      install: overrides.commitGateInstall ?? current.commitGate.install,
      mode: overrides.commitGateMode ?? current.commitGate.mode,
      scope: overrides.commitGateScope ?? current.commitGate.scope,
    },
  });
}

/** Set or clear (`mode` undefined) the personal worktree setting — one repo key, or all repos without one. */
export function writeWorktreePreference(
  mode: 'on' | 'off' | undefined,
  repoKey?: string,
): OnboardingPreferences {
  const current = readOnboardingPreferences();
  const repos = { ...current.worktree.repos };
  let fallback = current.worktree.default;
  if (repoKey === undefined) fallback = mode;
  else if (mode) repos[repoKey] = mode;
  else delete repos[repoKey];
  return writePreferences({ ...current, worktree: { repos, default: fallback } });
}

export function writeOnboardingPreferences(
  overrides: OnboardingPreferenceOverrides,
): OnboardingPreferences {
  return writePreferences(mergeOnboardingPreferences(readOnboardingPreferences(), overrides));
}

function writePreferences(preference: OnboardingPreferences): OnboardingPreferences {
  const parsed = OnboardingPreferencesSchema.parse({
    ...preference,
    updatedAt: new Date().toISOString(),
  });
  const preferencePath = getOnboardingPreferencesPath();
  fs.mkdirSync(path.dirname(preferencePath), { recursive: true });
  fs.writeFileSync(preferencePath, `${JSON.stringify(parsed, null, 2)}\n`);
  return parsed;
}
