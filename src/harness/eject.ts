import * as fs from 'fs';
import * as path from 'path';
import { getHarPackageVersion } from '../core/package-version';
import { computeHarnessChecksums, getHarnessDir, readManifest, writeManifest } from './manifest';
import type { HarnessProfile } from './profiles';
import { composeProfileTemplateMap, readComposedTemplateContent } from './profiles';
import { MANAGED_SHIM_FILES, substituteTemplateTokens } from './template-tokens';

/**
 * `har env eject` (#239) — explicit runtime ownership for power users.
 *
 * Ejecting vendors the packaged runtime (the same bundle `har` itself runs)
 * into `.har/runtime/` and rewrites the `.har/*.sh` scripts to execute it
 * directly with node — no `har` on PATH, no npx network fallback. From that
 * point the scripts and the vendored runtime are user-owned: drift/maintain
 * stop comparing them to upstream templates, while `har env doctor` keeps
 * validating the contract (stages resolve, env schema, registry shape).
 *
 * Reversible: `har env adopt` (or `har env init --force`) restores managed
 * shims and removes `.har/runtime/`.
 */

export const EJECTED_RUNTIME_DIR = 'runtime';
export const EJECTED_RUNTIME_BUNDLE = 'har.cjs';

export interface EjectResult {
  scripts: string[];
  runtimeFile: string;
  version: string;
}

export interface AdoptResult {
  scripts: string[];
}

/** Locate the built runtime bundle for both bundled (dist/index.js) and dev (tsx) runs. */
export function resolveRuntimeBundleSource(): string | null {
  if (process.env.HAR_EJECT_RUNTIME_SOURCE) {
    return fs.existsSync(process.env.HAR_EJECT_RUNTIME_SOURCE)
      ? process.env.HAR_EJECT_RUNTIME_SOURCE
      : null;
  }
  const candidates = [
    // Bundled CLI: __dirname is dist/ and index.js is the self-contained runtime.
    path.join(__dirname, 'index.js'),
    // Dev (tsx src/…): fall back to a previously built dist/ at the repo root.
    path.resolve(__dirname, '..', '..', 'dist', 'index.js'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * The managed shim's delegate line (`exec har env launch "$@"`, `exec har env
 * verify "$@"`, …) is the arg-convention contract each script must
 * keep. Ejected scripts reuse it verbatim against the vendored runtime.
 */
function shimDelegateArgs(templateContent: string): string | null {
  const match = templateContent.match(/^\s*exec har env (.+)$/m);
  return match ? match[1].trim() : null;
}

function usageLine(templateContent: string): string | null {
  const match = templateContent.match(/^# Usage: (.+)$/m);
  return match ? `# Usage: ${match[1].trim()}` : null;
}

function buildEjectedScript(name: string, delegateArgs: string, usage: string | null, version: string): string {
  return [
    '#!/usr/bin/env bash',
    `# EJECTED runtime (har env eject, @osfactory/har@${version}) — you own this file`,
    '# and .har/runtime/. HAR maintain/drift will not update them; har env doctor',
    '# still validates the harness contract. Return to managed shims: har env adopt.',
    ...(usage ? [usage] : []),
    'set -euo pipefail',
    'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
    `export HAR_PACKAGE_VERSION="\${HAR_PACKAGE_VERSION:-${version}}"`,
    `exec node "$SCRIPT_DIR/${EJECTED_RUNTIME_DIR}/${EJECTED_RUNTIME_BUNDLE}" env ${delegateArgs}`,
    '',
  ].join('\n');
}

const RUNTIME_README = (version: string): string => `# .har/runtime/ — ejected HAR runtime

This directory was created by \`har env eject\`. It contains the complete HAR
runtime bundle (@osfactory/har@${version}) that the \`.har/*.sh\` scripts execute
directly with node. You own these files:

- HAR will never update them — \`har env maintain\` treats them as user-owned
  and reports no upstream drift for them.
- \`har env doctor\` still validates the harness contract (harness.env schema,
  stages.json registry, stage scripts, port lanes).
- Support expectation: issues reproducible with the managed shims are
  supported; behavior you change in an ejected runtime is yours to maintain.
- Lifecycle commands that manage templates (\`init\`, \`maintain\`, \`eject\`,
  \`adopt\`, plugins) still require an installed \`har\`.

Return to managed shims (removes this directory, regenerates \`.har/*.sh\`):

    har env adopt

`;

/** Vendors the runtime into .har/runtime/ and rewrites the shims to execute it. */
export function ejectHarness(repoPath: string): EjectResult {
  const resolved = path.resolve(repoPath);
  const harnessDir = getHarnessDir(resolved);
  const manifest = readManifest(resolved);
  if (!manifest) {
    throw new Error('No .har/manifest.json found. Run "har env init" first.');
  }
  if (manifest.ejected) {
    throw new Error(
      `Harness is already ejected (@osfactory/har@${manifest.ejectedVersion ?? 'unknown'}). ` +
        'Run "har env adopt" first to return to managed shims.',
    );
  }

  const bundleSource = resolveRuntimeBundleSource();
  if (!bundleSource) {
    throw new Error('Cannot locate the built HAR runtime bundle (dist/index.js). Run npm run build.');
  }

  const version = getHarPackageVersion();
  const profile: HarnessProfile = manifest.profile ?? 'default';
  const composed = composeProfileTemplateMap(profile);

  const runtimeDir = path.join(harnessDir, EJECTED_RUNTIME_DIR);
  fs.mkdirSync(runtimeDir, { recursive: true });
  const runtimeFile = path.join(runtimeDir, EJECTED_RUNTIME_BUNDLE);
  fs.copyFileSync(bundleSource, runtimeFile);
  fs.chmodSync(runtimeFile, 0o755);
  fs.writeFileSync(path.join(runtimeDir, 'README.md'), RUNTIME_README(version));

  const scripts: string[] = [];
  for (const shim of MANAGED_SHIM_FILES) {
    const source = composed.get(shim);
    if (!source) continue;
    const templateContent = readComposedTemplateContent(source);
    const delegateArgs = shimDelegateArgs(templateContent);
    if (!delegateArgs) continue;
    const scriptPath = path.join(harnessDir, shim);
    fs.writeFileSync(scriptPath, buildEjectedScript(shim, delegateArgs, usageLine(templateContent), version));
    fs.chmodSync(scriptPath, 0o755);
    scripts.push(shim);
  }

  writeManifest(resolved, {
    ...manifest,
    ejected: true,
    ejectedVersion: version,
    fileChecksums: computeHarnessChecksums(harnessDir),
    updatedAt: new Date().toISOString(),
  });

  return { scripts, runtimeFile, version };
}

/** Reverses eject: regenerates managed shims and removes .har/runtime/. */
export function adoptHarness(repoPath: string): AdoptResult {
  const resolved = path.resolve(repoPath);
  const harnessDir = getHarnessDir(resolved);
  const manifest = readManifest(resolved);
  if (!manifest) {
    throw new Error('No .har/manifest.json found. Run "har env init" first.');
  }
  if (!manifest.ejected) {
    throw new Error('Harness is not ejected — the managed shims are already in place.');
  }

  const profile: HarnessProfile = manifest.profile ?? 'default';
  const composed = composeProfileTemplateMap(profile);
  const projectName = path.basename(resolved).toLowerCase().replace(/[^a-z0-9]/g, '_');

  const scripts: string[] = [];
  for (const shim of MANAGED_SHIM_FILES) {
    const source = composed.get(shim);
    if (!source) continue;
    const rendered = substituteTemplateTokens(readComposedTemplateContent(source), projectName);
    const scriptPath = path.join(harnessDir, shim);
    fs.writeFileSync(scriptPath, rendered);
    fs.chmodSync(scriptPath, 0o755);
    scripts.push(shim);
  }

  fs.rmSync(path.join(harnessDir, EJECTED_RUNTIME_DIR), { recursive: true, force: true });

  const rest = { ...manifest };
  delete rest.ejected;
  delete rest.ejectedVersion;
  writeManifest(resolved, {
    ...rest,
    fileChecksums: computeHarnessChecksums(harnessDir),
    updatedAt: new Date().toISOString(),
  });

  return { scripts };
}
