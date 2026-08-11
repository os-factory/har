import * as fs from 'fs';
import * as path from 'path';

/**
 * Executable stubs on PATH — how these tests exercise macOS-only tooling on a
 * Linux CI runner. One place on purpose: the stubbed xcodebuild contract is shared
 * by several suites, and a copy that drifts passes silently.
 */

/** Write an executable script into `<dir>/stub-bin` and return that directory. */
export function writeStubBin(dir: string, name: string, script: string): string {
  const binDir = path.join(dir, 'stub-bin');
  fs.mkdirSync(binDir, { recursive: true });
  const binPath = path.join(binDir, name);
  fs.writeFileSync(binPath, script.startsWith('#!') ? script : `#!/usr/bin/env bash\n${script}`);
  fs.chmodSync(binPath, 0o755);
  return binDir;
}

/** A stub that records the arguments it was called with into `markerPath`. */
export function writeRecordingStub(dir: string, name: string, markerPath: string): string {
  return writeStubBin(dir, name, `echo "$@" > ${JSON.stringify(markerPath)}\n`);
}

export interface XcodebuildStubOptions {
  /** Payload for `xcodebuild -list -json`. */
  list?: unknown;
  /** Payload for `xcodebuild -showBuildSettings -json`. */
  settings?: unknown;
  /** Non-zero to make `-list` fail. */
  listExit?: number;
  /** Stall before answering, to exercise timeout handling. */
  sleepSeconds?: number;
}

const DEFAULT_LIST = { project: { name: 'MyApp', schemes: ['MyApp'] } };
const DEFAULT_SETTINGS = [
  {
    buildSettings: {
      PRODUCT_BUNDLE_IDENTIFIER: 'com.acme.myapp',
      IPHONEOS_DEPLOYMENT_TARGET: '18.0',
    },
  },
];

/** Install a fake `xcodebuild` and return the directory to prepend to PATH. */
export function stubXcodebuild(dir: string, options: XcodebuildStubOptions = {}): string {
  const listJson = JSON.stringify(options.list ?? DEFAULT_LIST);
  const settingsJson = JSON.stringify(options.settings ?? DEFAULT_SETTINGS);
  const listExit = options.listExit ?? 0;
  const sleep = options.sleepSeconds ? `sleep ${options.sleepSeconds}` : ':';

  return writeStubBin(
    dir,
    'xcodebuild',
    [
      sleep,
      'for arg in "$@"; do',
      '  if [ "$arg" = "-list" ]; then',
      `    [ ${listExit} -ne 0 ] && { echo "xcodebuild: error" >&2; exit ${listExit}; }`,
      `    cat <<'JSON'`,
      listJson,
      'JSON',
      '    exit 0',
      '  fi',
      '  if [ "$arg" = "-showBuildSettings" ]; then',
      `    cat <<'JSON'`,
      settingsJson,
      'JSON',
      '    exit 0',
      '  fi',
      'done',
      'exit 1',
      '',
    ].join('\n'),
  );
}

/** Run `fn` with PATH temporarily replaced, restoring it even on failure. */
export function withPath<T>(pathValue: string, fn: () => T): T {
  const original = process.env.PATH;
  process.env.PATH = pathValue;
  try {
    return fn();
  } finally {
    process.env.PATH = original;
  }
}
