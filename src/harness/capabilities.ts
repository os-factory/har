import * as fs from 'fs';
import * as path from 'path';
import { readManifest, resolveHarnessRoot } from './manifest';
import { readHarnessEnv } from './env';
import { ProfileCapabilities, readProfileCapabilities } from './profiles';

/**
 * Stack capability detection (#236): the recorded profile's capability manifest
 * is the source of truth. File/env presence remains only as a legacy fallback
 * for pre-1.0 harnesses whose manifest records no profile.
 */

/** Capability set for the harness's recorded profile, or undefined (legacy harness). */
export function harnessCapabilities(repoPath: string): ProfileCapabilities | undefined {
  const harnessRoot = resolveHarnessRoot(repoPath);
  const profile = readManifest(harnessRoot)?.profile;
  if (!profile) return undefined;
  return readProfileCapabilities(profile);
}

/** Web/PM2 profile: per-slot app processes via ecosystem.agent.template.cjs */
export function harnessUsesPm2(repoPath: string): boolean {
  const capabilities = harnessCapabilities(repoPath);
  if (capabilities) return capabilities.processManager === 'pm2';
  const harnessRoot = resolveHarnessRoot(repoPath);
  return fs.existsSync(path.join(harnessRoot, '.har', 'ecosystem.agent.template.cjs'));
}

/** iOS profile: capability manifest, or the pre-#234 simulator.sh helper file */
export function harnessUsesSimulator(repoPath: string): boolean {
  const capabilities = harnessCapabilities(repoPath);
  if (capabilities) return capabilities.processManager === 'simulator';
  const harnessRoot = resolveHarnessRoot(repoPath);
  return fs.existsSync(path.join(harnessRoot, '.har', 'simulator.sh'));
}

/** Whether this harness expects per-slot TCP app ports (PM2 / FE+API base ports). */
export function harnessAllocatesAppPorts(repoPath: string): boolean {
  const capabilities = harnessCapabilities(repoPath);
  if (capabilities?.appPortLanes) return true;
  if (!capabilities && harnessUsesPm2(repoPath)) return true;
  const harnessRoot = resolveHarnessRoot(repoPath);
  const env = readHarnessEnv(harnessRoot);
  return Boolean(env.HARNESS_FE_BASE_PORT || env.HARNESS_API_BASE_PORT);
}

/** iOS / xcodebuild-oriented harness (capability manifest, scheme or simulator markers). */
export function harnessUsesXcode(repoPath: string): boolean {
  if (harnessUsesSimulator(repoPath)) return true;
  const harnessRoot = resolveHarnessRoot(repoPath);
  const env = readHarnessEnv(harnessRoot);
  return Boolean(env.HARNESS_XCODE_SCHEME || env.HARNESS_BUNDLE_ID);
}
