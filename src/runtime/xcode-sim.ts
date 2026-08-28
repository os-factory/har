import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { defaultExec, ExecFn, LogFn, SleepFn, realSleep } from './exec';

/**
 * Package-side per-slot iOS Simulator runtime (#234) — the TS home of the
 * xcode-sim bundle's simulator.sh.
 *
 * One booted simulator shared by every agent slot means concurrent xcodebuild
 * destinations, installs of the same bundle id, and UI flows collide. Each slot
 * instead gets a simulator of its own, created at launch and deleted at
 * teardown: unique by construction, pristine on every launch, and never a
 * device the developer is using by hand. What a slot holds is recorded in
 * .har/simulators/agent-<id>.json, so teardown knows whether the device was
 * HAR's to delete.
 */

export const simLog: LogFn = (message) => process.stderr.write(`==> simulator: ${message}\n`);

// ── Configuration ─────────────────────────────────────────────────────────────

export type SimulatorFamily = 'iPhone' | 'iPad';

/** Preferred device family: auto (infer from HARNESS_SIMULATOR_NAME) | iPhone | iPad */
export function preferredFamily(env: Record<string, string>): SimulatorFamily {
  const configured = env.HARNESS_SIMULATOR_FAMILY ?? 'auto';
  if (configured === 'iPhone' || configured === 'iPad') return configured;
  return /^ipad/i.test(env.HARNESS_SIMULATOR_NAME ?? '') ? 'iPad' : 'iPhone';
}

export function perSlotEnabled(env: Record<string, string>): boolean {
  return (env.HARNESS_SIMULATOR_SHARED ?? 'false') !== 'true';
}

/** "iPad Air 11-inch (M4)" → "iPad-Air-11-inch-M4" */
export function simSlug(value: string): string {
  return value
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-/, '')
    .replace(/-$/, '');
}

/**
 * Short digest of the repository path. Two checkouts can share a folder name,
 * and therefore HARNESS_PROJECT_NAME, but not a path — without it the prefix
 * sweep would delete the other checkout's live device.
 */
export function repoDigest(repoRoot: string): string {
  let resolved = repoRoot;
  try {
    // realpath so the same checkout reached through a symlink yields the same digest.
    resolved = fs.realpathSync(repoRoot);
  } catch {
    /* keep the given path, matching the script's fallback */
  }
  return crypto.createHash('sha1').update(resolved).digest('hex').slice(0, 6);
}

/**
 * Stable part of a slot's device name. The model is appended after it, so a
 * device left over from a launch on another model is still recognised as this
 * slot's and cleaned up.
 */
export function deviceLabelPrefix(
  env: Record<string, string>,
  repoRoot: string,
  agentId: number,
): string {
  return `har-${simSlug(env.HARNESS_PROJECT_NAME || 'har')}-${repoDigest(repoRoot)}-agent-${agentId}`;
}

export function deviceLabel(
  env: Record<string, string>,
  repoRoot: string,
  agentId: number,
  model?: string,
): string {
  const prefix = deviceLabelPrefix(env, repoRoot, agentId);
  const slug = simSlug(model ?? '');
  return slug ? `${prefix}-${slug}` : prefix;
}

// ── Claims ────────────────────────────────────────────────────────────────────
// Slots never compete for a device, so a claim only records what teardown must
// release — no locking, no cross-slot exclusion.

export interface SimulatorClaim {
  agentId: number;
  udid: string;
  name: string;
  createdByHar: boolean;
  claimedAt: string;
}

export function claimsDir(harnessDir: string): string {
  return path.join(harnessDir, 'simulators');
}

export function claimFile(harnessDir: string, agentId: number): string {
  return path.join(claimsDir(harnessDir), `agent-${agentId}.json`);
}

export function writeClaim(
  harnessDir: string,
  agentId: number,
  udid: string,
  name: string,
  createdByHar: boolean,
  now: () => Date = () => new Date(),
): void {
  const file = claimFile(harnessDir, agentId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const claim: SimulatorClaim = {
    agentId,
    udid,
    name,
    createdByHar,
    claimedAt: now().toISOString(),
  };
  fs.writeFileSync(file, JSON.stringify(claim, null, 2) + '\n');
}

export function readClaim(harnessDir: string, agentId: number): SimulatorClaim | undefined {
  const file = claimFile(harnessDir, agentId);
  if (!fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as SimulatorClaim;
  } catch {
    return undefined;
  }
}

/**
 * Agent id of another live slot holding this udid, if any. Only a pinned
 * HARNESS_SIMULATOR_UDID can produce that overlap. "Live" means the slot
 * registry file exists (slotIsLive mirrors slot_registry_file existence).
 */
export function claimOwnerOf(
  harnessDir: string,
  udid: string,
  selfAgentId: number,
  slotIsLive: (agentId: number) => boolean,
): number | undefined {
  const dir = claimsDir(harnessDir);
  if (!fs.existsSync(dir)) return undefined;
  for (const entry of fs.readdirSync(dir)) {
    const match = entry.match(/^agent-(\d+)\.json$/);
    if (!match) continue;
    const id = Number(match[1]);
    if (id === selfAgentId) continue;
    if (!slotIsLive(id)) continue;
    const claim = readClaim(harnessDir, id);
    if (claim?.udid === udid) return id;
  }
  return undefined;
}

// ── simctl access ─────────────────────────────────────────────────────────────

/**
 * Every simctl call goes through here, so "simctl could not be asked" stays
 * distinguishable from "simctl answered, and the answer is empty". A failed
 * call (or empty answer) returns undefined; callers check it instead of
 * reading an empty list as a fact about the machine.
 */
export class Simctl {
  private typesJson: string | undefined;
  private runtimesJson: string | undefined;
  private simctlOk = true;
  private simctlError = '';
  private causeReported = false;

  constructor(
    private readonly exec: ExecFn = defaultExec,
    private readonly log: LogFn = simLog,
  ) {}

  call(args: string[]): string | undefined {
    const result = this.exec('xcrun', ['simctl', ...args]);
    if (result.code !== 0 || result.stdout === '') return undefined;
    return result.stdout;
  }

  /** Best-effort call whose failure is ignored (boot/shutdown/delete paths). */
  tryCall(args: string[]): boolean {
    return this.exec('xcrun', ['simctl', ...args]).code === 0;
  }

  devicetypesJson(): string {
    if (this.typesJson === undefined) {
      this.typesJson = this.call(['list', 'devicetypes', '--json']) ?? '{}';
    }
    return this.typesJson;
  }

  runtimesJsonCached(): string {
    if (this.runtimesJson === undefined) {
      const out = this.call(['list', 'runtimes', '--json']);
      if (out !== undefined) {
        this.runtimesJson = out;
        this.simctlOk = true;
      } else {
        this.runtimesJson = '{}';
        this.simctlOk = false;
        // A second call, but only ever when simctl is already failing — its
        // stderr is the only thing that tells the causes apart.
        try {
          const probe = this.exec('sh', ['-c', 'xcrun simctl list runtimes --json 2>&1 >/dev/null']);
          this.simctlError = probe.stdout;
        } catch {
          this.simctlError = '';
        }
      }
    }
    return this.runtimesJson;
  }

  available(): boolean {
    this.runtimesJsonCached();
    return this.simctlOk;
  }

  /**
   * Two unrelated problems make simctl unusable — a sandbox denying the
   * CoreSimulatorService lookup, and a developer directory with no simctl in
   * it. Naming the wrong one costs the reader the hunt this exists to prevent.
   * The cause only needs saying once per process.
   */
  logUnavailable(): void {
    if (this.causeReported) return;
    this.causeReported = true;
    this.runtimesJsonCached();
    const error = this.simctlError;
    if (
      error.includes('not a developer tool') ||
      error.includes('unable to find utility') ||
      error.includes('command not found')
    ) {
      this.log("'xcrun simctl' is not in the selected developer directory");
      this.log('  install Xcode, then point the toolchain at it:');
      this.log('    sudo xcode-select -s /Applications/Xcode.app');
      const selection = this.exec('sh', ['-c', 'xcode-select -p 2>/dev/null']);
      this.log(`  current selection: ${selection.stdout.trim() || 'none'}`);
      return;
    }
    this.log("cannot reach CoreSimulatorService — 'xcrun simctl' is unusable here");
    this.log('  this usually means the command is running inside an agent sandbox');
    this.log("  run it from a normal terminal, or let the agent run 'xcrun simctl' unsandboxed");
  }
}

// ── Device discovery ──────────────────────────────────────────────────────────

interface SimDevice {
  udid?: string;
  name?: string;
  state?: string;
  isAvailable?: boolean;
}

function allDevices(devicesJson: string): Array<SimDevice & { runtime: string }> {
  try {
    const data = JSON.parse(devicesJson) as { devices?: Record<string, SimDevice[]> };
    return Object.entries(data.devices ?? {}).flatMap(([runtime, devices]) =>
      (devices ?? []).map((device) => ({ ...device, runtime })),
    );
  } catch {
    return [];
  }
}

/**
 * Unavailable devices are skipped: a device whose runtime was uninstalled must
 * not pass validation only to fail at boot. undefined means "could not ask".
 */
export function deviceField(
  simctl: Simctl,
  udid: string,
  field: 'state' | 'name',
): string | undefined {
  const devicesJson = simctl.call(['list', 'devices', '--json']);
  if (devicesJson === undefined) return undefined;
  const device = allDevices(devicesJson)
    .filter((entry) => entry.isAvailable !== false)
    .find((entry) => entry.udid === udid);
  const value = device?.[field];
  return value ? String(value) : '';
}

/**
 * UDID of an existing available device with this exact name, newest iOS
 * runtime first. A substring match would resolve "iPhone 16" to
 * "iPhone 16 Pro Max". Empty string when absent; undefined when simctl failed.
 */
export function deviceByName(simctl: Simctl, want: string): string | undefined {
  if (!want) return '';
  const devicesJson = simctl.call(['list', 'devices', 'available', '--json']);
  if (devicesJson === undefined) return undefined;
  const rows: Array<{ udid: string; version: number }> = [];
  for (const device of allDevices(devicesJson)) {
    if (!device.runtime.includes('SimRuntime.iOS-')) continue;
    const parts = device.runtime.match(/iOS-(\d+)(?:-(\d+))?/);
    const version = parts ? Number(parts[1]) * 1000 + Number(parts[2] ?? 0) : 0;
    if (!device.udid || device.isAvailable === false) continue;
    if (device.name !== want) continue;
    rows.push({ udid: device.udid, version });
  }
  rows.sort((a, b) => b.version - a.version);
  return rows[0]?.udid ?? '';
}

/**
 * Every device whose name is <prefix> or starts with "<prefix>-", so a slot's
 * leftovers are found whatever model they were created from. undefined when
 * simctl could not be asked.
 */
export function devicesWithPrefix(simctl: Simctl, prefix: string): string[] | undefined {
  const devicesJson = simctl.call(['list', 'devices', '--json']);
  if (devicesJson === undefined) return undefined;
  return allDevices(devicesJson)
    .filter((device) => device.udid)
    .filter((device) => device.name === prefix || String(device.name ?? '').startsWith(`${prefix}-`))
    .map((device) => device.udid as string);
}

/**
 * Never throws and reports success even when it could not look: the teardown
 * path runs under "keep going", and aborting would leave the slot registry
 * behind on top of the device.
 */
export function deleteDevicesWithPrefix(simctl: Simctl, prefix: string, log: LogFn = simLog): void {
  const udids = devicesWithPrefix(simctl, prefix);
  if (udids === undefined) {
    log(`cannot check for leftover devices named ${prefix}* — none were removed`);
    simctl.logUnavailable();
    return;
  }
  for (const udid of udids) {
    if (udid) simctl.tryCall(['delete', udid]);
  }
}

// ── Creation planning ─────────────────────────────────────────────────────────

export type CreationPlan =
  | { status: 'OK'; deviceTypeId: string; deviceTypeName: string; runtimeId: string; runtimeVersion: string }
  | { status: 'NO_RUNTIME' }
  | { status: 'NO_MODEL'; models: string }
  | { status: 'NO_RUNTIME_FOR_MODEL'; models: string }
  | { status: 'SIMCTL_UNAVAILABLE' };

interface DeviceType {
  identifier?: string;
  name?: string;
  productFamily?: string;
}

interface Runtime {
  identifier?: string;
  version?: string;
  isAvailable?: boolean;
  supportedDeviceTypes?: DeviceType[];
}

/**
 * Model and runtime to create this slot's device from. Failures carry the
 * models this machine can create, so the caller never re-derives that list.
 */
export function planCreation(
  simctl: Simctl,
  wantName: string,
  family: SimulatorFamily,
): CreationPlan {
  const typesRaw = simctl.devicetypesJson();
  const runtimesRaw = simctl.runtimesJsonCached();
  // Checked before the empty lists are read as an answer about the machine.
  if (!simctl.available()) return { status: 'SIMCTL_UNAVAILABLE' };

  let types: DeviceType[] = [];
  let runtimes: Runtime[] = [];
  try {
    types = (JSON.parse(typesRaw).devicetypes as DeviceType[]) ?? [];
  } catch {
    types = [];
  }
  const version = (value: unknown): number => {
    const [major = 0, minor = 0] = String(value ?? '0').split('.').map(Number);
    return major * 1000 + minor;
  };
  try {
    runtimes = ((JSON.parse(runtimesRaw).runtimes as Runtime[]) ?? [])
      .filter((runtime) => runtime.isAvailable !== false)
      .filter((runtime) => String(runtime.identifier ?? '').includes('SimRuntime.iOS-'))
      .sort((a, b) => version(b.version) - version(a.version));
  } catch {
    runtimes = [];
  }

  const isPad = (entry: DeviceType) => /ipad/i.test(entry.productFamily || entry.name || '');
  const inFamily = (entry: DeviceType) => (family === 'iPad' ? isPad(entry) : !isPad(entry));

  // Models the newest runtime could create, named so an error can list them.
  // Truncation is stated rather than silent — a model cut off the list still exists.
  const availableModels = (): string => {
    const runtime = runtimes[0];
    const supported =
      runtime && Array.isArray(runtime.supportedDeviceTypes) && runtime.supportedDeviceTypes.length
        ? runtime.supportedDeviceTypes
        : types;
    const names = supported.filter(inFamily).map((entry) => entry.name ?? '');
    const shown = names.slice(0, 8).join(', ');
    return names.length > 8 ? `${shown}, … (${names.length - 8} more)` : shown;
  };

  if (!runtimes.length) return { status: 'NO_RUNTIME' };
  if (wantName && !types.some((type) => type.name === wantName)) {
    return { status: 'NO_MODEL', models: availableModels() };
  }

  for (const runtime of runtimes) {
    const supported =
      Array.isArray(runtime.supportedDeviceTypes) && runtime.supportedDeviceTypes.length
        ? runtime.supportedDeviceTypes
        : types;
    // Apple lists supported device types newest first within each family.
    const pool = supported.filter(inFamily);
    const chosen = wantName ? pool.find((type) => type.name === wantName) : pool[0];
    if (chosen) {
      return {
        status: 'OK',
        deviceTypeId: chosen.identifier ?? '',
        deviceTypeName: chosen.name ?? '',
        runtimeId: runtime.identifier ?? '',
        runtimeVersion: String(runtime.version ?? ''),
      };
    }
  }
  return wantName
    ? { status: 'NO_RUNTIME_FOR_MODEL', models: availableModels() }
    : { status: 'NO_RUNTIME' };
}

// ── Boot ──────────────────────────────────────────────────────────────────────

export async function bootDevice(
  simctl: Simctl,
  udid: string,
  sleep: SleepFn = realSleep,
): Promise<boolean> {
  simctl.tryCall(['boot', udid]);
  if (simctl.tryCall(['bootstatus', udid, '-b'])) return true;
  // Fallback for a toolchain without bootstatus: poll the plain listing.
  for (let i = 1; i <= 30; i++) {
    const listing = simctl.call(['list', 'devices']);
    if (listing && new RegExp(`${udid}.*Booted`).test(listing)) return true;
    await sleep(2);
  }
  return false;
}

// ── Acquire / release ─────────────────────────────────────────────────────────

export interface SimulatorContext {
  env: Record<string, string>;
  harnessDir: string;
  repoRoot: string;
  agentId: number;
  simctl?: Simctl;
  log?: LogFn;
  sleep?: SleepFn;
  /** Whether a slot registry entry exists for an agent id (claim liveness). */
  slotIsLive?: (agentId: number) => boolean;
}

interface Selection {
  udid: string;
  name: string;
  createdByHar: boolean;
}

function selectDevice(ctx: Required<Pick<SimulatorContext, 'env' | 'harnessDir' | 'repoRoot' | 'agentId'>> & {
  simctl: Simctl;
  log: LogFn;
  slotIsLive: (agentId: number) => boolean;
}): Selection | undefined {
  const { env, harnessDir, repoRoot, agentId, simctl, log, slotIsLive } = ctx;
  const want = env.HARNESS_SIMULATOR_NAME ?? '';

  // An explicit UDID is a deliberate override — never fall back off it.
  const pinned = env.HARNESS_SIMULATOR_UDID;
  if (pinned) {
    // A failed lookup is "could not ask"; an empty one is "no such device".
    const name = deviceField(simctl, pinned, 'name');
    if (name === undefined) {
      simctl.logUnavailable();
      return undefined;
    }
    if (!name) {
      log(`HARNESS_SIMULATOR_UDID=${pinned} is not a known device`);
      return undefined;
    }
    const owner = claimOwnerOf(harnessDir, pinned, agentId, slotIsLive);
    if (owner !== undefined) {
      log(`warning: agent ${owner} already holds ${name} — a pinned HARNESS_SIMULATOR_UDID`);
      log('         gives every slot the same device; unset it to get one per slot.');
    }
    return { udid: pinned, name, createdByHar: false };
  }

  const family = preferredFamily(env);
  const plan = planCreation(simctl, want, family);

  if (plan.status === 'SIMCTL_UNAVAILABLE') {
    simctl.logUnavailable();
    return undefined;
  }

  if (plan.status === 'OK') {
    const label = deviceLabel(env, repoRoot, agentId, plan.deviceTypeName);
    // A crashed launch can leave the slot's device behind — start from scratch,
    // including a device this slot created from a different model.
    deleteDevicesWithPrefix(simctl, deviceLabelPrefix(env, repoRoot, agentId), log);
    log(`creating ${label} (${plan.deviceTypeName}, ${plan.runtimeId.split('SimRuntime.').pop()})`);
    const created = simctl.call(['create', label, plan.deviceTypeId, plan.runtimeId]);
    const udid = (created ?? '').replace(/\s/g, '');
    if (!udid) {
      log(`xcrun simctl create failed for ${label} (${plan.deviceTypeId}, ${plan.runtimeId})`);
      return undefined;
    }
    return { udid, name: label, createdByHar: true };
  }

  // Not a model: fall back to an existing device carrying that name, which is
  // how a hand-renamed simulator is targeted.
  if (plan.status === 'NO_MODEL') {
    const udid = deviceByName(simctl, want);
    if (udid) {
      log(`'${want}' is not a device model — using the existing device with that name`);
      return { udid, name: want, createdByHar: false };
    }
    log(`HARNESS_SIMULATOR_NAME='${want}' is neither a device model nor an existing device`);
    log(`  available ${family} models: ${plan.models}`);
    return undefined;
  }

  if (plan.status === 'NO_RUNTIME_FOR_MODEL') {
    log(`no installed iOS runtime supports '${want}'`);
    log('  install a newer runtime in Xcode → Settings → Components, or pick another model');
    log(`  available ${family} models: ${plan.models}`);
    return undefined;
  }

  log('no iOS simulator runtime is installed');
  log('  install one in Xcode → Settings → Components');
  return undefined;
}

/**
 * Reserve a simulator for a slot, boot it, and record the claim.
 * Returns { udid, name } on success, undefined on failure.
 */
export async function acquireSimulator(
  ctx: SimulatorContext,
): Promise<{ udid: string; name: string } | undefined> {
  const simctl = ctx.simctl ?? new Simctl();
  const log = ctx.log ?? simLog;
  const sleep = ctx.sleep ?? realSleep;
  const slotIsLive = ctx.slotIsLive ?? (() => false);

  const selection = selectDevice({ ...ctx, simctl, log, slotIsLive });
  if (!selection) return undefined;
  if (!selection.udid) {
    log('no simulator could be selected');
    return undefined;
  }
  writeClaim(ctx.harnessDir, ctx.agentId, selection.udid, selection.name, selection.createdByHar);

  if (!(await bootDevice(simctl, selection.udid, sleep))) {
    log(`device ${selection.name} (${selection.udid}) did not reach Booted state`);
    return undefined;
  }
  return { udid: selection.udid, name: selection.name };
}

/**
 * Drop a slot's claim. Devices HAR created are deleted; a device the developer
 * owns is left alone, and never even shut down. Also sweeps unclaimed
 * leftovers under the slot's prefix — only HAR creates devices there.
 */
export function releaseSimulator(
  ctx: SimulatorContext,
  stdout: (message: string) => void = (message) => process.stdout.write(`${message}\n`),
): void {
  const simctl = ctx.simctl ?? new Simctl();
  const log = ctx.log ?? simLog;
  const claim = readClaim(ctx.harnessDir, ctx.agentId);
  if (claim) {
    fs.rmSync(claimFile(ctx.harnessDir, ctx.agentId), { force: true });
    if (claim.createdByHar === true && claim.udid) {
      simctl.tryCall(['shutdown', claim.udid]);
      if (simctl.tryCall(['delete', claim.udid])) {
        stdout(`✓ Deleted simulator created for this slot (${claim.udid})`);
      } else {
        // Naming it is the whole remedy left: the claim is gone, so only the
        // name-prefix sweep at the next launch can still find this device.
        log(`could not delete ${claim.udid}, created for agent ${ctx.agentId} — it is still on this machine`);
        if (!simctl.available()) simctl.logUnavailable();
      }
    }
  }

  // A launch killed between `simctl create` and the claim leaves a device no
  // claim points at. Only HAR creates devices under this prefix.
  deleteDevicesWithPrefix(simctl, deviceLabelPrefix(ctx.env, ctx.repoRoot, ctx.agentId), log);
}
