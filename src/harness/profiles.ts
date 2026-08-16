import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { resolveTemplatesDir } from '../utils/paths';

export type HarnessProfile = 'default' | 'cli' | 'ios';

export const HARNESS_PROFILES = ['default', 'cli', 'ios'] as const;

const ProfileBundleRefSchema = z.object({
  /** Stable bundle id recorded in .har/plugins.json */
  id: z.string().min(1),
  /**
   * Directory under src/templates/ (e.g. "runtime-bundles/shared-kernel"
   * or "har-boilerplate").
   */
  path: z.string().min(1),
});

export const ProfileManifestSchema = z.object({
  id: z.enum(HARNESS_PROFILES),
  description: z.string().min(1),
  /** Ordered runtime bundles — later bundles overwrite earlier files on conflict. */
  bundles: z.array(ProfileBundleRefSchema).min(1),
});

export type ProfileManifest = z.infer<typeof ProfileManifestSchema>;
export type ProfileBundleRef = z.infer<typeof ProfileBundleRefSchema>;

/**
 * Built-in profile compositions (DeepSeek-style: profile = ordered bundles).
 * Shared kernel first; profile overlay last.
 */
const PROFILE_COMPOSITIONS: Record<HarnessProfile, ProfileManifest> = {
  default: {
    id: 'default',
    description: 'Web app — shared kernel + PM2 runtime + Docker infra',
    bundles: [
      { id: 'shared-kernel', path: 'runtime-bundles/shared-kernel' },
      { id: 'pm2-runtime', path: 'runtime-bundles/pm2-runtime' },
      { id: 'runtime-default', path: 'har-boilerplate' },
    ],
  },
  cli: {
    id: 'cli',
    description: 'CLI/library — shared kernel + CLI overlay (no PM2)',
    bundles: [
      { id: 'shared-kernel', path: 'runtime-bundles/shared-kernel' },
      { id: 'runtime-cli', path: 'har-boilerplate-cli' },
    ],
  },
  ios: {
    id: 'ios',
    description: 'iOS — shared kernel + Xcode/Simulator overlay',
    bundles: [
      { id: 'shared-kernel', path: 'runtime-bundles/shared-kernel' },
      { id: 'xcode-sim', path: 'runtime-bundles/xcode-sim' },
      { id: 'runtime-ios', path: 'har-boilerplate-ios' },
    ],
  },
};

/** @deprecated Prefer readProfileManifest — maps profile → primary overlay dir for maintain/drift. */
export const PROFILE_DIRS: Record<HarnessProfile, string> = {
  default: 'har-boilerplate',
  cli: 'har-boilerplate-cli',
  ios: 'har-boilerplate-ios',
};

export function readProfileManifest(profile: HarnessProfile): ProfileManifest {
  const templates = resolveTemplatesDir();
  const manifestPath = path.join(templates, 'profiles', profile, 'profile.manifest.json');
  if (fs.existsSync(manifestPath)) {
    const parsed = ProfileManifestSchema.safeParse(
      JSON.parse(fs.readFileSync(manifestPath, 'utf8')),
    );
    if (!parsed.success) {
      throw new Error(`Invalid profile manifest for ${profile}: ${parsed.error.message}`);
    }
    if (parsed.data.id !== profile) {
      throw new Error(`Profile manifest id mismatch: expected ${profile}, got ${parsed.data.id}`);
    }
    return parsed.data;
  }
  return PROFILE_COMPOSITIONS[profile];
}

export function resolveProfileBundleDir(bundle: ProfileBundleRef): string {
  const dir = path.join(resolveTemplatesDir(), bundle.path);
  if (!fs.existsSync(dir)) {
    throw new Error(`Profile bundle not found: ${bundle.id} (${bundle.path}). Run npm run build.`);
  }
  return dir;
}

export function listProfileBundleIds(profile: HarnessProfile): string[] {
  return readProfileManifest(profile).bundles.map((b) => b.id);
}
