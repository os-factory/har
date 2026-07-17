import { spawnSync } from 'child_process';
import * as path from 'path';
import {
  getControlImageRef,
  shouldBuildControlLocally,
} from './control-image';
import { getControlApiUrl, isControlEnabled } from './control-config';
import { parseControlHostPort } from './control-port';
import { syncAllKnownReposWithControl, waitForControlApi } from './control-sync';

/** Mission Control runs as a single self-contained container (SQLite on a volume). */
export const CONTROL_CONTAINER_NAME = 'har-control';
export const CONTROL_DATA_VOLUME = 'har_control_data';
const CONTROL_CONTAINER_PORT = 3847;
const CONTROL_DATA_DB_URL = 'file:/data/har_control.db';

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
}): string[] {
  const name = options.containerName ?? CONTROL_CONTAINER_NAME;
  const volume = options.volume ?? CONTROL_DATA_VOLUME;
  const args = ['run', '--name', name];
  if (options.detach) {
    args.push('-d', '--restart', 'unless-stopped');
  } else {
    args.push('--rm');
  }
  args.push(
    '-p',
    `${options.hostPort}:${CONTROL_CONTAINER_PORT}`,
    '-v',
    `${volume}:/data`,
    '-e',
    `DATABASE_URL=${CONTROL_DATA_DB_URL}`,
    options.imageRef,
  );
  return args;
}

function runDocker(args: string[]): number {
  const result = spawnSync('docker', args, {
    stdio: 'inherit',
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
}): Promise<{ code: number; apiUrl: string; imageRef: string }> {
  const build = options.build ?? shouldBuildControlLocally();
  const imageRef = getControlImageRef();
  const apiUrl = getControlApiUrl();
  const hostPort = parseControlHostPort(apiUrl);

  if (build) {
    const buildCode = runDocker([
      'build',
      '-t',
      imageRef,
      '-f',
      path.join(resolveControlDir(), 'Dockerfile'),
      resolveControlBuildContext(),
    ]);
    if (buildCode !== 0) {
      return { code: buildCode, apiUrl, imageRef };
    }
  } else {
    const pullCode = runDocker(['pull', imageRef]);
    if (pullCode !== 0) {
      return { code: pullCode, apiUrl, imageRef };
    }
  }

  // Replace any stale container so a re-run always lands on the current image.
  if (controlContainerExists()) {
    runDocker(['rm', '-f', CONTROL_CONTAINER_NAME]);
  }

  const detach = options.detach !== false;
  const code = runDocker(buildDockerRunArgs({ imageRef, hostPort, detach }));
  return { code, apiUrl, imageRef };
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
}> {
  const { code, apiUrl, imageRef } = await startMissionControl({
    detach: options?.detach,
    build: options?.build,
  });
  if (code !== 0) {
    return { code, apiUrl, imageRef, synced: 0, failed: 0, apiReady: false };
  }

  const { synced, failed, apiReady } = await syncReposAfterControlStart(options?.cwd ?? process.cwd());
  return { code, apiUrl, imageRef, synced, failed, apiReady };
}
