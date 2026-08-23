import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { run } from '../src/utils/shell';
import { resolveTemplatesDir } from '../src/utils/paths';

const IOS_TEMPLATE = 'har-boilerplate-ios';

const IPHONE_17 = {
  name: 'iPhone 17',
  identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17',
  productFamily: 'iPhone',
};
const IPHONE_16 = {
  name: 'iPhone 16',
  identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16',
  productFamily: 'iPhone',
};
const IPAD_AIR = {
  name: 'iPad Air 11-inch (M4)',
  identifier: 'com.apple.CoreSimulator.SimDeviceType.iPad-Air-11-inch-M4',
  productFamily: 'iPad',
};
const IPHONE_LEGACY = {
  name: 'iPhone 8',
  identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-8',
  productFamily: 'iPhone',
};

const DEVICE_TYPES = { devicetypes: [IPHONE_17, IPHONE_16, IPAD_AIR, IPHONE_LEGACY] };

// Apple lists supported device types newest first, and drops retired models from
// recent runtimes — iPhone 8 only exists on iOS 18.6 here.
const RUNTIMES = {
  runtimes: [
    {
      identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-18-6',
      version: '18.6',
      isAvailable: true,
      supportedDeviceTypes: [IPHONE_16, IPHONE_LEGACY, IPAD_AIR],
    },
    {
      identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
      version: '26.5',
      isAvailable: true,
      supportedDeviceTypes: [IPHONE_17, IPHONE_16, IPAD_AIR],
    },
    {
      identifier: 'com.apple.CoreSimulator.SimRuntime.watchOS-26-0',
      version: '26.0',
      isAvailable: true,
      supportedDeviceTypes: [],
    },
  ],
};

const DEVICES = {
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
      { udid: 'UDID-MY-IPHONE', name: 'My test phone', state: 'Booted', isAvailable: true },
      { udid: 'UDID-IPHONE-16', name: 'iPhone 16', state: 'Shutdown', isAvailable: true },
    ],
  },
};

/**
 * A .har directory wired to the iOS template, with `xcrun` stubbed so allocation
 * can be exercised without Xcode. `simctl create` appends to the device list, so
 * a created device is visible to later calls in the same test.
 */
const tempRoots: string[] = [];

function makeHarness(
  options: { simctlFailure?: 'sandbox' | 'missing'; noRuntimes?: boolean } = {},
): { root: string; harnessDir: string; binDir: string; callLog: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'har-ios-sim-'));
  tempRoots.push(root);
  const harnessDir = path.join(root, '.har');
  const binDir = path.join(root, 'bin');
  const callLog = path.join(root, 'xcrun-calls.log');
  fs.mkdirSync(harnessDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });

  // simulator.sh is bundle-provided since the composition; the rest stay in the overlay.
  const templateSource = (file: string): string =>
    file === 'simulator.sh'
      ? path.join(resolveTemplatesDir(), 'runtime-bundles', 'xcode-sim', file)
      : path.join(resolveTemplatesDir(), IOS_TEMPLATE, file);
  for (const file of ['agent-slot.sh', 'simulator.sh', 'setup-infra.sh', 'harness.env', 'stages.json']) {
    fs.copyFileSync(templateSource(file), path.join(harnessDir, file));
  }

  const devicesPath = path.join(root, 'devices.json');
  // Both leave xcodebuild working and kill every simctl subcommand, which is why
  // they are indistinguishable to a caller that only looks at an empty list.
  const simctlFailures = {
    // An agent sandbox denies the mach lookup to CoreSimulatorService.
    sandbox: `
if [ "\$1" = "simctl" ]; then
  echo "CoreSimulatorService connection became invalid.  Simulator services will no longer be available." >&2
  echo "Underlying error (domain=NSPOSIXErrorDomain, code=61): Connection refused" >&2
  exit 1
fi`,
    // xcode-select pointing at the Command Line Tools: simctl is not there at all.
    missing: `
if [ "\$1" = "simctl" ]; then
  echo 'xcrun: error: unable to find utility "simctl", not a developer tool or in PATH' >&2
  exit 72
fi`,
  };
  const failure = options.simctlFailure ? simctlFailures[options.simctlFailure] : '';
  const stub = `#!/usr/bin/env bash
echo "$*" >> ${JSON.stringify(callLog)}${failure}
if [ "\$1" != "simctl" ]; then exit 0; fi
case "\$2 \$3" in
  "list devices")     cat ${JSON.stringify(devicesPath)} ;;
  "list devicetypes") cat ${JSON.stringify(path.join(root, 'devicetypes.json'))} ;;
  "list runtimes")    cat ${JSON.stringify(path.join(root, 'runtimes.json'))} ;;
  "create "*|"create")
    COUNTER_FILE=${JSON.stringify(path.join(root, 'create-counter'))}
    COUNT=\$(( \$(cat "\$COUNTER_FILE" 2>/dev/null || echo 0) + 1 ))
    echo "\$COUNT" > "\$COUNTER_FILE"
    UDID="UDID-CREATED-\${COUNT}"
    node -e '
const fs = require("fs");
const [file, udid, name] = process.argv.slice(1);
const data = JSON.parse(fs.readFileSync(file, "utf8"));
const key = Object.keys(data.devices)[0];
data.devices[key].push({ udid, name, state: "Shutdown", isAvailable: true });
fs.writeFileSync(file, JSON.stringify(data));
' ${JSON.stringify(devicesPath)} "\$UDID" "\$3"
    echo "\$UDID"
    ;;
  *) : ;;
esac
exit 0
`;
  fs.writeFileSync(path.join(binDir, 'xcrun'), stub, { mode: 0o755 });
  fs.writeFileSync(path.join(binDir, 'xcodebuild'), '#!/usr/bin/env bash\necho "Xcode 26.5"\n', { mode: 0o755 });
  fs.writeFileSync(devicesPath, JSON.stringify(DEVICES));
  fs.writeFileSync(path.join(root, 'devicetypes.json'), JSON.stringify(DEVICE_TYPES));
  fs.writeFileSync(
    path.join(root, 'runtimes.json'),
    JSON.stringify(options.noRuntimes ? { runtimes: [] } : RUNTIMES),
  );

  return { root, harnessDir, binDir, callLog };
}

/** Mark a slot as live, holding a device. */
function claimFor(harnessDir: string, agentId: number, udid: string, createdByHar = false): void {
  fs.mkdirSync(path.join(harnessDir, 'slots'), { recursive: true });
  fs.mkdirSync(path.join(harnessDir, 'simulators'), { recursive: true });
  fs.writeFileSync(
    path.join(harnessDir, 'slots', `agent-${agentId}.json`),
    JSON.stringify({ agentId, status: 'active' }),
  );
  fs.writeFileSync(
    path.join(harnessDir, 'simulators', `agent-${agentId}.json`),
    JSON.stringify({ agentId, udid, name: udid, createdByHar }),
  );
}

/** Edit a value in the scaffolded harness.env, the way a project would. */
function setHarnessEnv(harnessDir: string, key: string, value: string): void {
  const file = path.join(harnessDir, 'harness.env');
  const content = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, content.replace(new RegExp(`^export ${key}=.*$`, 'm'), `export ${key}=${value}`));
}

/** setup-infra.sh writes its progress to stderr, which `run` only surfaces on failure. */
function runSetupInfra(harness: { harnessDir: string; binDir: string }) {
  return run(`bash "${path.join(harness.harnessDir, 'setup-infra.sh')}" 2>&1`, {
    env: { PATH: `${harness.binDir}:${process.env.PATH}` },
  });
}

function bash(
  harness: { root: string; harnessDir: string; binDir: string },
  snippet: string,
  env: Record<string, string> = {},
) {
  const exports = Object.entries(env)
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join('\n');
  const script = `#!/usr/bin/env bash
set -uo pipefail
export PATH=${JSON.stringify(harness.binDir)}:$PATH
SCRIPT_DIR=${JSON.stringify(harness.harnessDir)}
set -a
source "$SCRIPT_DIR/harness.env"
set +a
${exports}
source "$SCRIPT_DIR/agent-slot.sh"
source "$SCRIPT_DIR/simulator.sh"
${snippet}
`;
  const scriptPath = path.join(harness.root, 'snippet.sh');
  const errPath = path.join(harness.root, 'snippet.err');
  fs.writeFileSync(scriptPath, script);
  // `run` drops stderr on success, and the logs under test are written there.
  const result = run(`bash "${scriptPath}" 2>"${errPath}"`);
  return { ...result, stderr: fs.readFileSync(errPath, 'utf8') };
}

function claimOf(harnessDir: string, agentId: number) {
  return JSON.parse(fs.readFileSync(path.join(harnessDir, 'simulators', `agent-${agentId}.json`), 'utf8'));
}

/**
 * Device names carry a digest of the repository path, so two checkouts sharing a
 * folder name cannot sweep each other's devices.
 */
function expectedPrefix(harness: { root: string }, project: string, agentId: number): string {
  const digest = createHash('sha1').update(fs.realpathSync(harness.root)).digest('hex').slice(0, 6);
  return `har-${project}-${digest}-agent-${agentId}`;
}

describe('iOS per-slot simulator allocation', () => {
  afterEach(() => {
    while (tempRoots.length) {
      fs.rmSync(tempRoots.pop() as string, { recursive: true, force: true });
    }
  });

  it('ships simulator.sh with valid bash syntax and wires it into the lifecycle scripts', () => {
    const templateDir = path.join(resolveTemplatesDir(), IOS_TEMPLATE);
    const scriptPath = path.join(resolveTemplatesDir(), 'runtime-bundles', 'xcode-sim', 'simulator.sh');
    expect(fs.existsSync(scriptPath)).toBe(true);
    expect(run(`bash -n "${scriptPath}"`).code).toBe(0);

    for (const script of ['launch.sh', 'teardown.sh', 'setup-infra.sh', 'agent-cli.sh']) {
      expect(fs.readFileSync(path.join(templateDir, script), 'utf8')).toContain('simulator.sh');
    }
    expect(fs.readFileSync(path.join(templateDir, 'gitignore.template'), 'utf8')).toContain('simulators/');
  });

  it('writes the slot device into .env.agent after the toolchain, and releases it on failure', () => {
    const launch = fs.readFileSync(path.join(resolveTemplatesDir(), IOS_TEMPLATE, 'launch.sh'), 'utf8');

    // %q, or a simulator name with a space breaks every `source .env.agent.<id>`.
    for (const key of ['HARNESS_SIMULATOR_UDID', 'HARNESS_SIMULATOR_DEVICE_NAME', 'HARNESS_IOS_DESTINATION']) {
      expect(launch).toContain(`printf '${key}=%q\\n'`);
    }
    expect(launch).toContain('platform=iOS Simulator,id=${SIM_UDID}');
    // The block must come after provisioning, or the shared default would win.
    expect(launch.indexOf('har_sim_acquire')).toBeGreaterThan(launch.indexOf('provision-toolchain.sh'));
    // A launch that dies after creating the device must give it back.
    expect(launch).toMatch(/mark_slot_failed\(\)[\s\S]*har_sim_release "\$AGENT_ID"/);
  });

  it('names the device after the slot and the model', () => {
    const harness = makeHarness();
    const result = bash(harness, 'har_sim_acquire 2', {
      HARNESS_SIMULATOR_NAME: 'iPhone 16',
      HARNESS_PROJECT_NAME: 'demo_app',
    });

    expect(result.code).toBe(0);
    const prefix = expectedPrefix(harness, 'demo_app', 2);
    expect(result.stdout).toContain(`${prefix}-iPhone-16`);

    const calls = fs.readFileSync(harness.callLog, 'utf8');
    // Newest runtime that supports the model, not merely the newest runtime.
    expect(calls).toContain(
      `simctl create ${prefix}-iPhone-16 com.apple.CoreSimulator.SimDeviceType.iPhone-16 com.apple.CoreSimulator.SimRuntime.iOS-26-5`,
    );
    expect(claimOf(harness.harnessDir, 2).createdByHar).toBe(true);
  });

  it('slugs a model whose name has spaces and parentheses', () => {
    const harness = makeHarness();
    const result = bash(harness, 'har_sim_acquire 1', {
      HARNESS_SIMULATOR_NAME: 'iPad Air 11-inch (M4)',
      HARNESS_PROJECT_NAME: 'demo',
    });

    expect(result.code).toBe(0);
    expect(claimOf(harness.harnessDir, 1).name).toBe(`${expectedPrefix(harness, 'demo', 1)}-iPad-Air-11-inch-M4`);
  });

  it('leaves the developer own devices untouched, even a matching one', () => {
    const harness = makeHarness();
    const result = bash(harness, 'har_sim_acquire 1', { HARNESS_SIMULATOR_NAME: 'iPhone 16' });

    expect(result.code).toBe(0);
    // "iPhone 16" also exists as a device here; the model still wins.
    expect(claimOf(harness.harnessDir, 1).udid).not.toBe('UDID-IPHONE-16');
    expect(claimOf(harness.harnessDir, 1).createdByHar).toBe(true);
  });

  it('falls back to the newest model of the family when no model is configured', () => {
    const harness = makeHarness();
    const result = bash(harness, 'har_sim_acquire 1', { HARNESS_SIMULATOR_NAME: '' });

    expect(result.code).toBe(0);
    expect(fs.readFileSync(harness.callLog, 'utf8')).toContain(
      'com.apple.CoreSimulator.SimDeviceType.iPhone-17 com.apple.CoreSimulator.SimRuntime.iOS-26-5',
    );
  });

  it('creates an iPad only when the family resolves to iPad', () => {
    const harness = makeHarness();

    const iphone = bash(harness, 'har_sim_acquire 1', { HARNESS_SIMULATOR_NAME: '' });
    expect(iphone.code).toBe(0);
    expect(fs.readFileSync(harness.callLog, 'utf8')).not.toContain('iPad-Air');

    const ipad = bash(harness, 'har_sim_acquire 2', {
      HARNESS_SIMULATOR_NAME: '',
      HARNESS_SIMULATOR_FAMILY: 'iPad',
    });
    expect(ipad.code).toBe(0);
    expect(fs.readFileSync(harness.callLog, 'utf8')).toContain('SimDeviceType.iPad-Air-11-inch-M4');
  });

  it('picks the newest runtime that still supports a retired model', () => {
    const harness = makeHarness();
    const result = bash(harness, 'har_sim_acquire 1', { HARNESS_SIMULATOR_NAME: 'iPhone 8' });

    expect(result.code).toBe(0);
    // iPhone 8 is gone from iOS 26.5, so the plan must drop to 18.6.
    expect(fs.readFileSync(harness.callLog, 'utf8')).toContain(
      'com.apple.CoreSimulator.SimDeviceType.iPhone-8 com.apple.CoreSimulator.SimRuntime.iOS-18-6',
    );
  });

  it('deletes a device left behind by a crashed launch, even on another model', () => {
    const harness = makeHarness();
    bash(harness, 'har_sim_acquire 1', { HARNESS_PROJECT_NAME: 'demo', HARNESS_SIMULATOR_NAME: 'iPhone 16' });
    const first = claimOf(harness.harnessDir, 1).udid;
    fs.rmSync(path.join(harness.harnessDir, 'simulators', 'agent-1.json'));

    // The model changed in harness.env since: only the slot prefix still matches.
    bash(harness, 'har_sim_acquire 1', { HARNESS_PROJECT_NAME: 'demo', HARNESS_SIMULATOR_NAME: 'iPhone 17' });

    expect(fs.readFileSync(harness.callLog, 'utf8')).toContain(`simctl delete ${first}`);
    expect(claimOf(harness.harnessDir, 1).name).toBe(`${expectedPrefix(harness, 'demo', 1)}-iPhone-17`);
    expect(claimOf(harness.harnessDir, 1).udid).not.toBe(first);
  });

  it('rejects a model this machine cannot create, listing what it can', () => {
    const harness = makeHarness();
    const result = bash(harness, 'har_sim_acquire 1', { HARNESS_SIMULATOR_NAME: 'iPhone 99' });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('neither a device model nor an existing device');
    expect(result.stderr).toContain('iPhone 17');
    expect(fs.readFileSync(harness.callLog, 'utf8')).not.toContain('simctl create');
  });

  it('uses an existing device when the configured name is a hand-renamed simulator', () => {
    const harness = makeHarness();
    const result = bash(harness, 'har_sim_acquire 1', { HARNESS_SIMULATOR_NAME: 'My test phone' });

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('UDID-MY-IPHONE\tMy test phone');
    expect(claimOf(harness.harnessDir, 1).createdByHar).toBe(false);
    expect(fs.readFileSync(harness.callLog, 'utf8')).not.toContain('simctl create');
  });

  it('rejects an explicit UDID that no device matches instead of falling back', () => {
    const harness = makeHarness();
    const result = bash(harness, 'har_sim_acquire 1', { HARNESS_SIMULATOR_UDID: 'UDID-GONE' });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('not a known device');
  });

  it('warns when a pinned UDID is already held by another slot', () => {
    const harness = makeHarness();
    claimFor(harness.harnessDir, 1, 'UDID-MY-IPHONE');

    const result = bash(harness, 'har_sim_acquire 2', { HARNESS_SIMULATOR_UDID: 'UDID-MY-IPHONE' });

    expect(result.code).toBe(0);
    expect(result.stderr).toContain('agent 1 already holds');
    expect(claimOf(harness.harnessDir, 2).createdByHar).toBe(false);
  });

  it('deletes a device on release only when HAR created it', () => {
    const harness = makeHarness();
    claimFor(harness.harnessDir, 1, 'UDID-MY-IPHONE', false);
    claimFor(harness.harnessDir, 2, 'UDID-CREATED-42', true);

    const result = bash(harness, 'har_sim_release 1; har_sim_release 2');

    expect(result.code).toBe(0);
    const calls = fs.readFileSync(harness.callLog, 'utf8');
    expect(calls).toContain('simctl delete UDID-CREATED-42');
    expect(calls).not.toContain('simctl delete UDID-MY-IPHONE');
    expect(fs.existsSync(path.join(harness.harnessDir, 'simulators', 'agent-1.json'))).toBe(false);
    expect(fs.existsSync(path.join(harness.harnessDir, 'simulators', 'agent-2.json'))).toBe(false);
  });

  it('runs setup-infra without booting a device when slots create their own', () => {
    const harness = makeHarness();
    const result = runSetupInfra(harness);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('launch creates one iPhone 16 per agent');
    expect(fs.readFileSync(harness.callLog, 'utf8')).not.toContain('simctl boot');
  });

  it('fails setup-infra on an unusable model, before any worktree exists', () => {
    const harness = makeHarness();
    setHarnessEnv(harness.harnessDir, 'HARNESS_SIMULATOR_NAME', '"iPhone 99"');

    const result = runSetupInfra(harness);

    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain('no simulator can be prepared');
    expect(result.stdout).toContain('iPhone 17');
  });

  it('reports simctl being unreachable rather than blaming a missing runtime', () => {
    const harness = makeHarness({ simctlFailure: 'sandbox' });

    const result = runSetupInfra(harness);

    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain('cannot reach CoreSimulatorService');
    expect(result.stdout).toContain('sandbox');
    expect(result.stdout).not.toContain('No iOS runtime is installed');
  });

  it('fails a slot launch with the simctl diagnostic, creating nothing', () => {
    const harness = makeHarness({ simctlFailure: 'sandbox' });

    const result = bash(harness, 'har_sim_acquire 1', { HARNESS_SIMULATOR_NAME: 'iPhone 16' });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('cannot reach CoreSimulatorService');
    expect(result.stderr).not.toContain('no iOS simulator runtime is installed');
    expect(fs.readFileSync(harness.callLog, 'utf8')).not.toContain('simctl create');
  });

  it('names the toolchain, not a sandbox, when simctl is not installed', () => {
    const harness = makeHarness({ simctlFailure: 'missing' });

    const result = bash(harness, 'har_sim_acquire 1', { HARNESS_SIMULATOR_NAME: 'iPhone 16' });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('not in the selected developer directory');
    expect(result.stderr).toContain('xcode-select');
    expect(result.stderr).not.toContain('sandbox');
  });

  // The message the whole change exists to preserve: a reachable simctl reporting
  // no iOS runtime must still send the reader to Xcode, not to a sandbox.
  it('still blames a missing runtime when simctl answers with none', () => {
    const harness = makeHarness({ noRuntimes: true });

    const result = runSetupInfra(harness);

    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain('No iOS runtime is installed');
    expect(result.stdout).not.toContain('CoreSimulatorService');
  });

  it('does not call a pinned UDID unknown when simctl is unreachable', () => {
    const harness = makeHarness({ simctlFailure: 'sandbox' });

    const result = bash(harness, 'har_sim_acquire 1', { HARNESS_SIMULATOR_UDID: 'UDID-MY-IPHONE' });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('cannot reach CoreSimulatorService');
    expect(result.stderr).not.toContain('not a known device');
  });

  it('reports simctl being unreachable in shared mode too', () => {
    const harness = makeHarness({ simctlFailure: 'sandbox' });
    setHarnessEnv(harness.harnessDir, 'HARNESS_SIMULATOR_SHARED', 'true');

    const result = runSetupInfra(harness);

    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain('cannot reach CoreSimulatorService');
    expect(result.stdout).not.toContain('not found in available devices');
  });

  // The claim is dropped even though the delete failed: nothing reads it once the
  // slot registry is gone, and keeping it makes `agent-cli.sh <id> simulator`
  // report a live reservation for a torn-down slot.
  it('drops the claim and names the device release could not delete', () => {
    const harness = makeHarness({ simctlFailure: 'sandbox' });
    claimFor(harness.harnessDir, 1, 'UDID-CREATED-7', true);

    const result = bash(harness, 'har_sim_release 1', { HARNESS_PROJECT_NAME: 'demo' });

    expect(result.stderr).toContain('cannot reach CoreSimulatorService');
    expect(result.stderr).toContain('UDID-CREATED-7');
    expect(fs.existsSync(path.join(harness.harnessDir, 'simulators', 'agent-1.json'))).toBe(false);
    // No cleanup may be claimed that did not happen.
    expect(result.stdout).not.toContain('Deleted simulator');
  });

  it('reports that leftover devices could not even be looked for', () => {
    const harness = makeHarness({ simctlFailure: 'sandbox' });

    const result = bash(harness, 'har_sim_release 1', { HARNESS_PROJECT_NAME: 'demo' });

    expect(result.stderr).toContain('cannot check for leftover devices');
  });

  it('lets setup-infra pass when the name is an existing device rather than a model', () => {
    const harness = makeHarness();
    setHarnessEnv(harness.harnessDir, 'HARNESS_SIMULATOR_NAME', '"My test phone"');

    const result = runSetupInfra(harness);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("reuses the existing device 'My test phone'");
  });

  it('deletes an orphan device left with no claim at all', () => {
    const harness = makeHarness();
    // A launch killed between `simctl create` and the claim: the device exists,
    // nothing records it, and teardown must still remove it.
    const orphan = `${expectedPrefix(harness, 'demo', 1)}-iPhone-16`;
    const devices = JSON.parse(fs.readFileSync(path.join(harness.root, 'devices.json'), 'utf8'));
    devices.devices['com.apple.CoreSimulator.SimRuntime.iOS-26-5'].push({
      udid: 'UDID-ORPHAN',
      name: orphan,
      state: 'Booted',
      isAvailable: true,
    });
    fs.writeFileSync(path.join(harness.root, 'devices.json'), JSON.stringify(devices));

    const result = bash(harness, 'har_sim_release 1', { HARNESS_PROJECT_NAME: 'demo' });

    expect(result.code).toBe(0);
    expect(fs.readFileSync(harness.callLog, 'utf8')).toContain('simctl delete UDID-ORPHAN');
  });

  it('scopes the device prefix to the repository path, not just its folder name', () => {
    const first = makeHarness();
    const second = makeHarness();

    bash(first, 'har_sim_acquire 1', { HARNESS_PROJECT_NAME: 'app', HARNESS_SIMULATOR_NAME: 'iPhone 16' });
    bash(second, 'har_sim_acquire 1', { HARNESS_PROJECT_NAME: 'app', HARNESS_SIMULATOR_NAME: 'iPhone 16' });

    // Same project name, different checkouts: the sweep in the second launch
    // must not have matched — and therefore deleted — the first one's device.
    const firstName = claimOf(first.harnessDir, 1).name;
    const secondName = claimOf(second.harnessDir, 1).name;
    expect(firstName).not.toBe(secondName);
    expect(fs.readFileSync(second.callLog, 'utf8')).not.toContain(`simctl delete ${claimOf(first.harnessDir, 1).udid}`);
  });

  it('still boots the configured device in shared mode', () => {
    const harness = makeHarness();
    setHarnessEnv(harness.harnessDir, 'HARNESS_SIMULATOR_SHARED', 'true');

    const result = runSetupInfra(harness);

    expect(result.code).toBe(0);
    // Exact name: shared mode targets the existing "iPhone 16" device.
    expect(fs.readFileSync(harness.callLog, 'utf8')).toContain('simctl boot UDID-IPHONE-16\n');
  });
});
