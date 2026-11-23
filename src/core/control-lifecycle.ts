import { spawnSync } from 'child_process';
import * as path from 'path';
import {
  DEFAULT_CONTROL_IMAGE,
  getControlImageRef,
  shouldBuildControlLocally,
} from './control-image';
import { DEFAULT_CONTROL_API_URL, getControlApiUrl, isControlEnabled } from './control-config';
import { parseControlHostPort } from './control-port';
import { isPortInUse } from './slot-ports';
import { syncAllKnownReposWithControl, waitForControlApi } from './control-sync';
import { ensureDestinationsDir } from './telemetry-destinations';
import { HAR_DESTINATIONS_DIR_ENV } from '../harness/schema';

/** Mission Control runs as a single self-contained container (SQLite on a volume). */
export const CONTROL_CONTAINER_NAME = 'har-control';
export const CONTROL_DATA_VOLUME = 'har_control_data';
const CONTROL_CONTAINER_PORT = 3847;
/** OTLP/gRPC receiver inside the container (the OTLP default port). */
export const CONTROL_OTLP_GRPC_CONTAINER_PORT = 4317;
/** Host port for Mission Control's OTLP/gRPC receiver; `0`/`off` skips publishing it. */
export const CONTROL_OTLP_GRPC_PORT_ENV = 'HAR_CONTROL_OTLP_GRPC_PORT';
const CONTROL_DATA_DB_URL = 'file:/data/har_control.db';
/** Where the host's `~/.har/destinations` appears inside the container (read-only). */
export const CONTROL_DESTINATIONS_MOUNT = '/har/destinations';

export function resolveControlDir(): string {
  // dist/index.js → package root/control (npm install or source checkout)
  return path.resolve(__dirname, '..', 'control');
}

/** Docker build context — the package root (Dockerfile COPYs packages/schemas + control). */
export function resolveControlBuildContext(): string {
  return path.resolve(resolveControlDir(), '..');
}

/** Pure arg builder for `docker run` — kept separate so it can be unit-tested. */
export function buildDockerRunArgs(options: {
  imageRef: string;
  hostPort: number;
  detach: boolean;
  containerName?: string;
  volume?: string;
  /** Host directory holding OTLP destination config, mounted read-only when given. */
  destinationsDir?: string;
  /** Host port published for the OTLP/gRPC receiver; omitted → not published. */
  otlpGrpcHostPort?: number | null;
  /** Defaults to the current platform; Linux gets a `host.docker.internal` entry. */
  platform?: NodeJS.Platform;
}): string[] {
  const name = options.containerName ?? CONTROL_CONTAINER_NAME;
  const volume = options.volume ?? CONTROL_DATA_VOLUME;
  const args = ['run', '--name', name];
  if (options.detach) {
    args.push('-d', '--restart', 'unless-stopped');
  } else {
    args.push('--rm');
  }
  args.push('-p', `${options.hostPort}:${CONTROL_CONTAINER_PORT}`);
  if (options.otlpGrpcHostPort) {
    args.push('-p', `${options.otlpGrpcHostPort}:${CONTROL_OTLP_GRPC_CONTAINER_PORT}`);
  }
  // Docker Desktop resolves host.docker.internal; on Linux it must be added, so
  // forwarding can reach a Collector listening on the host.
  if ((options.platform ?? process.platform) === 'linux') {
    args.push('--add-host=host.docker.internal:host-gateway');
  }
  args.push(
    '-v',
    `${volume}:/data`,
    '-e',
    `DATABASE_URL=${CONTROL_DATA_DB_URL}`,
  );
  if (options.destinationsDir) {
    args.push(
      '-v',
      `${options.destinationsDir}:${CONTROL_DESTINATIONS_MOUNT}:ro`,
      '-e',
      `${HAR_DESTINATIONS_DIR_ENV}=${CONTROL_DESTINATIONS_MOUNT}`,
    );
  }
  args.push(options.imageRef);
  return args;
}

/** Host port for the OTLP/gRPC receiver: 4317 by default, null when `HAR_CONTROL_OTLP_GRPC_PORT` is 0/off/false. */
export function resolveControlOtlpGrpcHostPort(env: Record<string, string | undefined> = process.env): number | null {
  const raw = env[CONTROL_OTLP_GRPC_PORT_ENV]?.trim().toLowerCase();
  if (!raw) return CONTROL_OTLP_GRPC_CONTAINER_PORT;
  if (raw === '0' || raw === 'off' || raw === 'false') return null;
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : CONTROL_OTLP_GRPC_CONTAINER_PORT;
}

export interface ControlOtlpGrpcPlan {
  /** Host port to publish, or null when it is not published. */
  hostPort: number | null;
  /** Why it is not published (busy port), for a one-line hint. */
  hint?: string;
}

/** Publish the OTLP/gRPC port unless disabled or already taken on the host (never fails `up`). */
export function planControlOtlpGrpcPort(
  env: Record<string, string | undefined> = process.env,
  portInUse: (port: number) => boolean = isPortInUse,
): ControlOtlpGrpcPlan {
  const hostPort = resolveControlOtlpGrpcHostPort(env);
  if (hostPort === null) return { hostPort: null };
  if (portInUse(hostPort)) {
    return {
      hostPort: null,
      hint:
        `port ${hostPort} is in use, so OTLP/gRPC is not published (OTLP/HTTP still works). ` +
        `Free it, or set ${CONTROL_OTLP_GRPC_PORT_ENV} to another port and run har control up again.`,
    };
  }
  return { hostPort };
}

/** OTLP endpoints a client on this host points at. */
export function controlOtlpEndpoints(apiUrl: string, otlpGrpcHostPort: number | null): { http: string; grpc?: string } {
  return {
    http: `${apiUrl.replace(/\/+$/, '')}/api/otel`,
    ...(otlpGrpcHostPort ? { grpc: `grpc://localhost:${otlpGrpcHostPort}` } : {}),
  };
}

function runDocker(args: string[], quiet = false): number {
  const result = spawnSync('docker', args, {
    stdio: quiet ? ['ignore', 'ignore', 'inherit'] : 'inherit',
    env: process.env,
  });
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1;
}

/** True when a container named har-control exists (running or stopped). */
export function controlContainerExists(name = CONTROL_CONTAINER_NAME): boolean {
  const result = spawnSync('docker', ['ps', '-aq', '-f', `name=^${name}$`], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  return (result.stdout ?? '').trim().length > 0;
}

/** Stop and remove the Mission Control container (the SQLite volume is preserved). */
export function stopMissionControl(): number {
  if (!controlContainerExists()) {
    return 0;
  }
  return runDocker(['rm', '-f', CONTROL_CONTAINER_NAME]);
}

export async function startMissionControl(options: {
  detach?: boolean;
  build?: boolean;
  quiet?: boolean;
}): Promise<{
  code: number;
  apiUrl: string;
  imageRef: string;
  reason?: string;
  /** Published OTLP/gRPC host port (null when not published) and why not. */
  otlpGrpc?: ControlOtlpGrpcPlan;
}> {
  const quiet = options.quiet ?? false;
  const build = options.build ?? shouldBuildControlLocally();
  const imageRef = getControlImageRef();
  const apiUrl = getControlApiUrl();
  const hostPort = parseControlHostPort(apiUrl);

  // The CLI targets another Mission Control: the default container is not its
  // own. Replacing it would delete the user's running instance and publish its
  // data volume on that other instance's port.
  if (!isDefaultControlUrl(apiUrl) && controlContainerExists()) {
    return {
      code: 1,
      apiUrl,
      imageRef,
      reason:
        `the ${CONTROL_CONTAINER_NAME} container serves ${DEFAULT_CONTROL_API_URL}, not ${apiUrl}; ` +
        `start the Mission Control at ${apiUrl} yourself, or unset HAR_CONTROL_API_URL`,
    };
  }

  if (build) {
    const buildCode = runDocker(
      [
        'build',
        '-t',
        imageRef,
        '-f',
        path.join(resolveControlDir(), 'Dockerfile'),
        resolveControlBuildContext(),
      ],
      quiet,
    );
    if (buildCode !== 0) {
      return { code: buildCode, apiUrl, imageRef };
    }
  } else {
    const pullCode = runDocker(['pull', imageRef], quiet);
    if (pullCode !== 0) {
      return { code: pullCode, apiUrl, imageRef };
    }
  }

  // Replace any stale container so a re-run always lands on the current image.
  if (controlContainerExists()) {
    runDocker(['rm', '-f', CONTROL_CONTAINER_NAME], quiet);
  }

  const detach = options.detach !== false;
  // Mission Control forwards received OTLP to the destinations configured with
  // `har telemetry destination add`. The directory is created up front so
  // Docker does not create it as root; with no destinations it stays empty.
  let destinationsDir: string | undefined;
  try {
    destinationsDir = ensureDestinationsDir();
  } catch {
    destinationsDir = undefined;
  }
  // After the old container is gone, so its own 4317 does not count as taken.
  const otlpGrpc = planControlOtlpGrpcPort();
  const code = runDocker(
    buildDockerRunArgs({ imageRef, hostPort, detach, destinationsDir, otlpGrpcHostPort: otlpGrpc.hostPort }),
    quiet,
  );
  return { code, apiUrl, imageRef, otlpGrpc };
}

/** Host port the container publishes for OTLP/gRPC (null when not published or unknown). */
export function controlContainerOtlpGrpcHostPort(name = CONTROL_CONTAINER_NAME): number | null {
  const result = spawnSync('docker', ['port', name, `${CONTROL_OTLP_GRPC_CONTAINER_PORT}/tcp`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const match = /:(\d+)\s*$/m.exec(result.stdout ?? '');
  return match ? Number(match[1]) : null;
}

/** Whether the running container mounts the destinations directory (false when absent or unknown). */
export function controlContainerMountsDestinations(name = CONTROL_CONTAINER_NAME): boolean | null {
  const result = spawnSync('docker', ['inspect', '-f', '{{json .Mounts}}', name], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  if (result.error || result.status !== 0) return null;
  try {
    const mounts = JSON.parse((result.stdout ?? '').trim() || '[]') as Array<{ Destination?: string }>;
    return mounts.some((mount) => mount.Destination === CONTROL_DESTINATIONS_MOUNT);
  } catch {
    return null;
  }
}

export function controlContainerImage(name = CONTROL_CONTAINER_NAME): string | null {
  const result = spawnSync('docker', ['inspect', '-f', '{{.Config.Image}}', name], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  if (result.error || result.status !== 0) return null;
  return (result.stdout ?? '').trim() || null;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Whether `apiUrl` reaches the default container: a loopback host on the default port. */
function isDefaultControlUrl(apiUrl: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(apiUrl).hostname;
  } catch {
    return false;
  }
  return (
    LOOPBACK_HOSTS.has(hostname) &&
    parseControlHostPort(apiUrl) === parseControlHostPort(DEFAULT_CONTROL_API_URL)
  );
}

/** Only a released default image is replaced; overrides and custom tags are left alone. */
export function shouldUpgradeControlImage(
  running: string,
  expected: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.HAR_CONTROL_IMAGE || env.HAR_CONTROL_IMAGE_TAG) return false;
  // The CLI talks to another Mission Control: the default container is not its
  // own, and recreating it would publish it on that other instance's port.
  if (env.HAR_CONTROL_API_URL && !isDefaultControlUrl(env.HAR_CONTROL_API_URL)) return false;
  if (running === expected) return false;
  return new RegExp(`^${DEFAULT_CONTROL_IMAGE}:\\d+\\.\\d+\\.\\d+`).test(running);
}

/** The container outlives CLI upgrades (`--restart unless-stopped`), so recreate it on the CLI's image. */
export async function upgradeStaleMissionControl(): Promise<
  { upgraded: false } | { upgraded: true; from: string; to: string; code: number }
> {
  const running = controlContainerImage();
  const expected = getControlImageRef();
  if (!running || !shouldUpgradeControlImage(running, expected)) {
    return { upgraded: false };
  }
  const { code, apiUrl } = await startMissionControl({ detach: true, quiet: true });
  if (code === 0) {
    await waitForControlApi(apiUrl);
  }
  return { upgraded: true, from: running, to: expected, code };
}

export async function syncReposAfterControlStart(cwd?: string): Promise<{
  synced: number;
  failed: number;
  apiReady: boolean;
}> {
  if (!isControlEnabled()) {
    return { synced: 0, failed: 0, apiReady: false };
  }

  const apiUrl = getControlApiUrl();
  const apiReady = await waitForControlApi(apiUrl);
  if (!apiReady) {
    return { synced: 0, failed: 0, apiReady: false };
  }

  const { synced, failed } = await syncAllKnownReposWithControl({ apiUrl, cwd });
  return { synced, failed, apiReady: true };
}

export async function startControlAndSync(options?: {
  detach?: boolean;
  build?: boolean;
  cwd?: string;
}): Promise<{
  code: number;
  apiUrl: string;
  imageRef: string;
  synced: number;
  failed: number;
  apiReady: boolean;
  otlpGrpc?: ControlOtlpGrpcPlan;
}> {
  const { code, apiUrl, imageRef, otlpGrpc } = await startMissionControl({
    detach: options?.detach,
    build: options?.build,
  });
  if (code !== 0) {
    return { code, apiUrl, imageRef, synced: 0, failed: 0, apiReady: false, otlpGrpc };
  }

  const { synced, failed, apiReady } = await syncReposAfterControlStart(options?.cwd ?? process.cwd());
  return { code, apiUrl, imageRef, synced, failed, apiReady, otlpGrpc };
}
