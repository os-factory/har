import * as fs from 'fs';
import * as path from 'path';
import { getHarPackageVersion } from '../core/package-version';
import { computeHarnessChecksums, getHarnessDir, readManifest, writeManifest } from './manifest';
import { retireLifecycleShims } from './lifecycle-shims';

/**
 * `har env eject` (#239 / #314) — explicit runtime ownership for power users.
 *
 * Ejecting vendors the packaged runtime (the same bundle `har` itself runs)
 * into `.har/runtime/`. Invocation is `har env …` or
 * `node .har/runtime/har.cjs env …` — no wrapper scripts. Drift/maintain stop
 * comparing the vendored runtime to upstream; `har env doctor` keeps
 * validating the contract (stages resolve, env schema, registry shape).
 *
 * Reversible: `har env adopt` (or `har env init --force`) removes
 * `.har/runtime/` and returns to the packaged runtime.
 */

export const EJECTED_RUNTIME_DIR = 'runtime';
export const EJECTED_RUNTIME_BUNDLE = 'har.cjs';

export interface EjectResult {
  /** Always empty after #314 — wrappers are not generated. */
  scripts: string[];
  runtimeFile: string;
  version: string;
}

export interface AdoptResult {
  /** Wrappers pruned on the way back, if any leftovers remained. */
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

const RUNTIME_README = (version: string): string => `# .har/runtime/ — ejected HAR runtime

This directory was created by \`har env eject\`. It contains the complete HAR
runtime bundle (@osfactory/har@${version}). You own these files:

- Drive the harness with \`har env …\` or \`node .har/runtime/har.cjs env …\`.
- HAR will never update this directory — \`har env maintain\` treats it as
  user-owned and reports no upstream drift for it.
- \`har env doctor\` still validates the harness contract (harness.env schema,
  stages.json registry, stage scripts, port lanes).
- Support expectation: issues reproducible with the packaged runtime are
  supported; behavior you change in an ejected runtime is yours to maintain.
- Lifecycle commands that manage templates (\`init\`, \`maintain\`, \`eject\`,
  \`adopt\`, plugins) still require an installed \`har\`.

Return to the packaged runtime (removes this directory):

    har env adopt

`;

/** Vendors the runtime into .har/runtime/. Does not write wrapper scripts. */
export function ejectHarness(repoPath: string): EjectResult {
  const resolved = path.resolve(repoPath);
  const harnessDir = getHarnessDir(resolved);
  const manifest = readManifest(resolved);
  if (!manifest) {
    throw new Error('No .har/manifest.json found. Run "har onboard" first.');
  }
  if (manifest.ejected) {
    throw new Error(
      `Harness is already ejected (@osfactory/har@${manifest.ejectedVersion ?? 'unknown'}). ` +
        'Run "har env adopt" first to return to the packaged runtime.',
    );
  }

  const bundleSource = resolveRuntimeBundleSource();
  if (!bundleSource) {
    throw new Error('Cannot locate the built HAR runtime bundle (dist/index.js). Run npm run build.');
  }

  const version = getHarPackageVersion();

  const runtimeDir = path.join(harnessDir, EJECTED_RUNTIME_DIR);
  fs.mkdirSync(runtimeDir, { recursive: true });
  const runtimeFile = path.join(runtimeDir, EJECTED_RUNTIME_BUNDLE);
  fs.copyFileSync(bundleSource, runtimeFile);
  fs.chmodSync(runtimeFile, 0o755);
  fs.writeFileSync(path.join(runtimeDir, 'README.md'), RUNTIME_README(version));

  retireLifecycleShims(resolved);

  writeManifest(resolved, {
    ...manifest,
    ejected: true,
    ejectedVersion: version,
    fileChecksums: computeHarnessChecksums(harnessDir),
    updatedAt: new Date().toISOString(),
  });

  return { scripts: [], runtimeFile, version };
}

/** Reverses eject: removes .har/runtime/ and any leftover lifecycle wrappers. */
export function adoptHarness(repoPath: string): AdoptResult {
  const resolved = path.resolve(repoPath);
  const harnessDir = getHarnessDir(resolved);
  const manifest = readManifest(resolved);
  if (!manifest) {
    throw new Error('No .har/manifest.json found. Run "har onboard" first.');
  }
  if (!manifest.ejected) {
    throw new Error('Harness is not ejected — the packaged runtime is already in use.');
  }

  fs.rmSync(path.join(harnessDir, EJECTED_RUNTIME_DIR), { recursive: true, force: true });
  const retired = retireLifecycleShims(resolved);

  const rest = { ...manifest };
  delete rest.ejected;
  delete rest.ejectedVersion;
  writeManifest(resolved, {
    ...rest,
    fileChecksums: computeHarnessChecksums(harnessDir),
    updatedAt: new Date().toISOString(),
  });

  return { scripts: retired.pruned };
}
