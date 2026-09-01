import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ExecFn } from '../src/runtime/exec';
import {
  acquireSimulator,
  claimFile,
  claimOwnerOf,
  deviceByName,
  deviceField,
  deviceLabel,
  deviceLabelPrefix,
  devicesWithPrefix,
  perSlotEnabled,
  planCreation,
  preferredFamily,
  readClaim,
  releaseSimulator,
  repoDigest,
  Simctl,
  simSlug,
  writeClaim,
} from '../src/runtime/xcode-sim';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'har-runtime-sim-'));
}

/** simctl mock: map from joined args prefix → stdout (undefined entry = failure). */
function mockSimctl(handlers: Array<{ match: (line: string) => boolean; stdout?: string; code?: number }>) {
  const calls: string[] = [];
  const exec: ExecFn = (command, args) => {
    const line = [command, ...args].join(' ');
    calls.push(line);
    const hit = handlers.find((h) => h.match(line));
    if (!hit) return { stdout: '', code: 1 };
    return { stdout: hit.stdout ?? '', code: hit.code ?? 0 };
  };
  return { simctl: new Simctl(exec, () => undefined), calls, exec };
}

const RUNTIMES = JSON.stringify({
  runtimes: [
    {
      identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-17-5',
      version: '17.5',
      isAvailable: true,
      supportedDeviceTypes: [
        { identifier: 'type.iPhone15', name: 'iPhone 15', productFamily: 'iPhone' },
        { identifier: 'type.iPadAir', name: 'iPad Air 11-inch (M4)', productFamily: 'iPad' },
      ],
    },
    {
      identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-16-4',
      version: '16.4',
      isAvailable: true,
      supportedDeviceTypes: [{ identifier: 'type.iPhone14', name: 'iPhone 14', productFamily: 'iPhone' }],
    },
  ],
});

const DEVICETYPES = JSON.stringify({
  devicetypes: [
    { identifier: 'type.iPhone15', name: 'iPhone 15', productFamily: 'iPhone' },
    { identifier: 'type.iPhone14', name: 'iPhone 14', productFamily: 'iPhone' },
    { identifier: 'type.iPadAir', name: 'iPad Air 11-inch (M4)', productFamily: 'iPad' },
  ],
});

describe('configuration helpers', () => {
  it('preferredFamily honors explicit config then infers from the device name', () => {
    expect(preferredFamily({ HARNESS_SIMULATOR_FAMILY: 'iPad' })).toBe('iPad');
    expect(preferredFamily({ HARNESS_SIMULATOR_NAME: 'iPad Air 11-inch (M4)' })).toBe('iPad');
    expect(preferredFamily({ HARNESS_SIMULATOR_NAME: 'iPhone 15' })).toBe('iPhone');
    expect(preferredFamily({})).toBe('iPhone');
  });

  it('perSlotEnabled is off only when HARNESS_SIMULATOR_SHARED=true', () => {
    expect(perSlotEnabled({})).toBe(true);
    expect(perSlotEnabled({ HARNESS_SIMULATOR_SHARED: 'true' })).toBe(false);
  });

  it('simSlug matches the tr/sed pipeline', () => {
    expect(simSlug('iPad Air 11-inch (M4)')).toBe('iPad-Air-11-inch-M4');
    expect(simSlug('iPhone 15')).toBe('iPhone-15');
    expect(simSlug('--weird  name--')).toBe('weird-name');
  });

  it('repoDigest is a stable 6-char sha1 fragment of the resolved path', () => {
    const dir = tmpDir();
    const digest = repoDigest(dir);
    expect(digest).toMatch(/^[0-9a-f]{6}$/);
    expect(repoDigest(dir)).toBe(digest);
    expect(repoDigest(tmpDir())).not.toBe(digest);
  });

  it('device labels carry project slug, repo digest, agent id, then model', () => {
    const repo = tmpDir();
    const env = { HARNESS_PROJECT_NAME: 'My App' };
    const prefix = deviceLabelPrefix(env, repo, 2);
    expect(prefix).toBe(`har-My-App-${repoDigest(repo)}-agent-2`);
    expect(deviceLabel(env, repo, 2, 'iPhone 15')).toBe(`${prefix}-iPhone-15`);
    expect(deviceLabel(env, repo, 2)).toBe(prefix);
  });
});

describe('claims', () => {
  it('writeClaim writes the simulator.sh JSON shape', () => {
    const harnessDir = tmpDir();
    writeClaim(harnessDir, 3, 'UDID-3', 'har-x-agent-3', true, () => new Date('2026-08-24T00:00:00.000Z'));
    const raw = fs.readFileSync(claimFile(harnessDir, 3), 'utf8');
    expect(raw).toBe(
      JSON.stringify(
        {
          agentId: 3,
          udid: 'UDID-3',
          name: 'har-x-agent-3',
          createdByHar: true,
          claimedAt: '2026-08-24T00:00:00.000Z',
        },
        null,
        2,
      ) + '\n',
    );
    expect(readClaim(harnessDir, 3)?.udid).toBe('UDID-3');
  });

  it('claimOwnerOf reports only live slots holding the udid', () => {
    const harnessDir = tmpDir();
    writeClaim(harnessDir, 1, 'SHARED', 'dev', false);
    writeClaim(harnessDir, 2, 'SHARED', 'dev', false);
    writeClaim(harnessDir, 4, 'OTHER', 'dev', false);
    const live = new Set([1, 4]);
    expect(claimOwnerOf(harnessDir, 'SHARED', 2, (id) => live.has(id))).toBe(1);
    expect(claimOwnerOf(harnessDir, 'SHARED', 1, (id) => id === 2)).toBe(2);
    expect(claimOwnerOf(harnessDir, 'SHARED', 1, () => false)).toBeUndefined();
    expect(claimOwnerOf(tmpDir(), 'SHARED', 1, () => true)).toBeUndefined();
  });
});

describe('device discovery', () => {
  const DEVICES = JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-16-4': [
        { udid: 'OLD', name: 'iPhone 15', state: 'Shutdown', isAvailable: true },
      ],
      'com.apple.CoreSimulator.SimRuntime.iOS-17-5': [
        { udid: 'NEW', name: 'iPhone 15', state: 'Booted', isAvailable: true },
        { udid: 'GONE', name: 'iPhone 15', state: 'Shutdown', isAvailable: false },
        { udid: 'PFX1', name: 'har-p-abc123-agent-1', state: 'Shutdown', isAvailable: true },
        { udid: 'PFX2', name: 'har-p-abc123-agent-1-iPhone-15', state: 'Shutdown', isAvailable: true },
        { udid: 'PFX10', name: 'har-p-abc123-agent-10', state: 'Shutdown', isAvailable: true },
      ],
    },
  });

  it('deviceByName picks the newest runtime and only exact names', () => {
    const { simctl } = mockSimctl([{ match: (l) => l.includes('list devices available --json'), stdout: DEVICES }]);
    expect(deviceByName(simctl, 'iPhone 15')).toBe('NEW');
    expect(deviceByName(simctl, 'iPhone')).toBe('');
    expect(deviceByName(simctl, '')).toBe('');
  });

  it('deviceByName distinguishes failure from absence', () => {
    const { simctl } = mockSimctl([]);
    expect(deviceByName(simctl, 'iPhone 15')).toBeUndefined();
  });

  it('deviceField skips unavailable devices', () => {
    const { simctl } = mockSimctl([{ match: (l) => l.includes('list devices --json'), stdout: DEVICES }]);
    expect(deviceField(simctl, 'NEW', 'state')).toBe('Booted');
    expect(deviceField(simctl, 'GONE', 'name')).toBe('');
  });

  it('devicesWithPrefix matches the prefix itself and "<prefix>-" but not "<prefix>1"', () => {
    const { simctl } = mockSimctl([{ match: (l) => l.includes('list devices --json'), stdout: DEVICES }]);
    expect(devicesWithPrefix(simctl, 'har-p-abc123-agent-1')).toEqual(['PFX1', 'PFX2']);
  });
});

describe('planCreation', () => {
  function planWith(runtimes: string, types = DEVICETYPES, want = '', family: 'iPhone' | 'iPad' = 'iPhone') {
    const { simctl } = mockSimctl([
      { match: (l) => l.includes('list devicetypes --json'), stdout: types },
      { match: (l) => l.includes('list runtimes --json'), stdout: runtimes },
    ]);
    return planCreation(simctl, want, family);
  }

  it('picks the wanted model on the newest runtime that supports it', () => {
    expect(planWith(RUNTIMES, DEVICETYPES, 'iPhone 15')).toEqual({
      status: 'OK',
      deviceTypeId: 'type.iPhone15',
      deviceTypeName: 'iPhone 15',
      runtimeId: 'com.apple.CoreSimulator.SimRuntime.iOS-17-5',
      runtimeVersion: '17.5',
    });
  });

  it('falls through runtimes for a model only an older one supports', () => {
    const plan = planWith(RUNTIMES, DEVICETYPES, 'iPhone 14');
    expect(plan).toMatchObject({ status: 'OK', runtimeId: 'com.apple.CoreSimulator.SimRuntime.iOS-16-4' });
  });

  it('defaults to the first in-family model when no name is configured', () => {
    expect(planWith(RUNTIMES)).toMatchObject({ status: 'OK', deviceTypeName: 'iPhone 15' });
    expect(planWith(RUNTIMES, DEVICETYPES, '', 'iPad')).toMatchObject({
      status: 'OK',
      deviceTypeName: 'iPad Air 11-inch (M4)',
    });
  });

  it('reports NO_RUNTIME / NO_MODEL / NO_RUNTIME_FOR_MODEL / SIMCTL_UNAVAILABLE', () => {
    expect(planWith(JSON.stringify({ runtimes: [] }))).toEqual({ status: 'NO_RUNTIME' });
    expect(planWith(RUNTIMES, DEVICETYPES, 'Nokia 3310')).toMatchObject({ status: 'NO_MODEL' });
    const iphoneOnlyRuntime = JSON.stringify({
      runtimes: [
        {
          identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-17-5',
          version: '17.5',
          supportedDeviceTypes: [{ identifier: 'type.iPhone15', name: 'iPhone 15', productFamily: 'iPhone' }],
        },
      ],
    });
    expect(planWith(iphoneOnlyRuntime, DEVICETYPES, 'iPhone 14')).toMatchObject({
      status: 'NO_RUNTIME_FOR_MODEL',
      models: 'iPhone 15',
    });
    const { simctl } = mockSimctl([{ match: (l) => l.includes('devicetypes'), stdout: DEVICETYPES }]);
    expect(planCreation(simctl, '', 'iPhone')).toEqual({ status: 'SIMCTL_UNAVAILABLE' });
  });

  it('truncates the model list at 8, stating the overflow', () => {
    const manyTypes = JSON.stringify({
      devicetypes: Array.from({ length: 11 }, (_, i) => ({
        identifier: `type.${i}`,
        name: `iPhone ${i}`,
        productFamily: 'iPhone',
      })),
    });
    const noSupported = JSON.stringify({
      runtimes: [{ identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-17-5', version: '17.5' }],
    });
    const plan = planWith(noSupported, manyTypes, 'Nokia 3310');
    expect(plan.status).toBe('NO_MODEL');
    if (plan.status === 'NO_MODEL') {
      expect(plan.models.endsWith(', … (3 more)')).toBe(true);
      expect(plan.models.split(', ').slice(0, 8)).toHaveLength(8);
    }
  });
});

describe('acquire / release', () => {
  it('acquire with a pinned unknown UDID fails without falling back', async () => {
    const { simctl } = mockSimctl([
      { match: (l) => l.includes('list devices --json'), stdout: JSON.stringify({ devices: {} }) },
      { match: (l) => l.includes('list runtimes --json'), stdout: RUNTIMES },
    ]);
    const logs: string[] = [];
    const result = await acquireSimulator({
      env: { HARNESS_PROJECT_NAME: 'p', HARNESS_SIMULATOR_UDID: 'NOPE' },
      harnessDir: tmpDir(),
      repoRoot: tmpDir(),
      agentId: 1,
      simctl,
      log: (m) => logs.push(m),
      sleep: async () => undefined,
    });
    expect(result).toBeUndefined();
    expect(logs).toContain('HARNESS_SIMULATOR_UDID=NOPE is not a known device');
  });

  it('acquire creates, claims, and boots a per-slot device', async () => {
    const harnessDir = tmpDir();
    const repoRoot = tmpDir();
    const env = { HARNESS_PROJECT_NAME: 'p', HARNESS_SIMULATOR_NAME: 'iPhone 15' };
    const prefix = deviceLabelPrefix(env, repoRoot, 1);
    const { simctl, calls } = mockSimctl([
      { match: (l) => l.includes('list devicetypes --json'), stdout: DEVICETYPES },
      { match: (l) => l.includes('list runtimes --json'), stdout: RUNTIMES },
      { match: (l) => l.includes('list devices --json'), stdout: JSON.stringify({ devices: {} }) },
      { match: (l) => l.includes('simctl create'), stdout: 'NEW-UDID\n' },
      { match: (l) => l.includes('simctl boot '), code: 0 },
      { match: (l) => l.includes('bootstatus'), code: 0 },
    ]);
    const result = await acquireSimulator({
      env,
      harnessDir,
      repoRoot,
      agentId: 1,
      simctl,
      log: () => undefined,
      sleep: async () => undefined,
    });
    expect(result).toEqual({ udid: 'NEW-UDID', name: `${prefix}-iPhone-15` });
    expect(readClaim(harnessDir, 1)).toMatchObject({ udid: 'NEW-UDID', createdByHar: true });
    expect(calls.some((c) => c.startsWith(`xcrun simctl create ${prefix}-iPhone-15 type.iPhone15`))).toBe(true);
  });

  it('release deletes only devices HAR created, then sweeps the prefix', () => {
    const harnessDir = tmpDir();
    const repoRoot = tmpDir();
    const env = { HARNESS_PROJECT_NAME: 'p' };
    writeClaim(harnessDir, 1, 'MINE', 'har-p-x-agent-1-iPhone-15', true);
    const { simctl, calls } = mockSimctl([
      { match: (l) => l.includes('shutdown'), code: 0 },
      { match: (l) => l.includes('delete'), code: 0 },
      { match: (l) => l.includes('list devices --json'), stdout: JSON.stringify({ devices: {} }) },
    ]);
    const out: string[] = [];
    releaseSimulator({ env, harnessDir, repoRoot, agentId: 1, simctl, log: () => undefined }, (m) => out.push(m));
    expect(fs.existsSync(claimFile(harnessDir, 1))).toBe(false);
    expect(calls).toContain('xcrun simctl shutdown MINE');
    expect(calls).toContain('xcrun simctl delete MINE');
    expect(out).toEqual(['✓ Deleted simulator created for this slot (MINE)']);
  });

  it('release leaves developer-owned devices alone', () => {
    const harnessDir = tmpDir();
    writeClaim(harnessDir, 2, 'DEV-DEVICE', 'iPhone 15', false);
    const { simctl, calls } = mockSimctl([
      { match: (l) => l.includes('list devices --json'), stdout: JSON.stringify({ devices: {} }) },
    ]);
    releaseSimulator({
      env: { HARNESS_PROJECT_NAME: 'p' },
      harnessDir,
      repoRoot: tmpDir(),
      agentId: 2,
      simctl,
      log: () => undefined,
    });
    expect(calls.some((c) => c.includes('shutdown') || c.includes('delete DEV-DEVICE'))).toBe(false);
    expect(fs.existsSync(claimFile(harnessDir, 2))).toBe(false);
  });
});
