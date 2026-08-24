import * as fs from 'fs';
import * as path from 'path';
import { readManifest, resolveHarnessRoot } from './manifest';
import { readHarnessEnv } from './env';

/**
 * Stack capability detection — prefer file/env presence over profile enum.
 * Profiles compose runtime bundles that drop these marker files; core stays stack-blind.
 */

/** Web/PM2 profile: per-slot app processes via ecosystem.agent.template.cjs */
export function harnessUsesPm2(repoPath: string): boolean {
  const harnessRoot = resolveHarnessRoot(repoPath);
  return fs.existsSync(path.join(harnessRoot, '.har', 'ecosystem.agent.template.cjs'));
}

/** iOS profile: manifest profile, or the pre-#234 simulator.sh helper file */
export function harnessUsesSimulator(repoPath: string): boolean {
  const harnessRoot = resolveHarnessRoot(repoPath);
  if (readManifest(harnessRoot)?.profile === 'ios') return true;
  return fs.existsSync(path.join(harnessRoot, '.har', 'simulator.sh'));
}

/** Whether this harness expects per-slot TCP app ports (PM2 / FE+API base ports). */
export function harnessAllocatesAppPorts(repoPath: string): boolean {
  if (harnessUsesPm2(repoPath)) return true;
  const harnessRoot = resolveHarnessRoot(repoPath);
  const env = readHarnessEnv(harnessRoot);
  return Boolean(env.HARNESS_FE_BASE_PORT || env.HARNESS_API_BASE_PORT);
}

/** iOS / xcodebuild-oriented harness (scheme or simulator markers). */
export function harnessUsesXcode(repoPath: string): boolean {
  if (harnessUsesSimulator(repoPath)) return true;
  const harnessRoot = resolveHarnessRoot(repoPath);
  const env = readHarnessEnv(harnessRoot);
  return Boolean(env.HARNESS_XCODE_SCHEME || env.HARNESS_BUNDLE_ID);
}
