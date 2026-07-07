import { spawnSync } from 'child_process';
import * as path from 'path';
import {
  getControlImageName,
  getControlImageRef,
  getControlImageTag,
  shouldBuildControlLocally,
} from './control-image';
import { getControlApiUrl, isControlEnabled } from './control-config';
import { syncAllKnownReposWithControl, waitForControlApi } from './control-sync';

export function resolveControlDir(): string {
  // dist/index.js → package root/control (npm install or source checkout)
  return path.resolve(__dirname, '..', 'control');
}

export function resolveControlComposeFiles(options?: { build?: boolean }): string[] {
  const controlDir = resolveControlDir();
  const files = [path.join(controlDir, 'docker-compose.yml')];
  if (options?.build ?? shouldBuildControlLocally()) {
    files.push(path.join(controlDir, 'docker-compose.build.yml'));
  }
  return files;
}

export function buildDockerComposeEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HAR_CONTROL_IMAGE: getControlImageName(),
    HAR_CONTROL_IMAGE_TAG: getControlImageTag(),
  };
}

export function runDockerCompose(args: string[], options?: { build?: boolean }): number {
  const controlDir = resolveControlDir();
  const composeFiles = resolveControlComposeFiles(options);
  const composeArgs = composeFiles.flatMap((file) => ['-f', file]);
  const result = spawnSync('docker', ['compose', ...composeArgs, ...args], {
    cwd: controlDir,
    stdio: 'inherit',
    env: buildDockerComposeEnv(),
  });
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1;
}

export async function startMissionControl(options: {
  detach?: boolean;
  build?: boolean;
}): Promise<{ code: number; apiUrl: string; imageRef: string }> {
  const build = options.build ?? shouldBuildControlLocally();
  const imageRef = getControlImageRef();

  if (!build) {
    const pullCode = runDockerCompose(['pull'], { build: false });
    if (pullCode !== 0) {
      return { code: pullCode, apiUrl: getControlApiUrl(), imageRef };
    }
  }

  const detach = options.detach !== false;
  const upArgs = detach ? ['up', '-d'] : ['up'];
  if (build) {
    upArgs.push('--build');
  }
  const code = runDockerCompose(upArgs, { build });
  return { code, apiUrl: getControlApiUrl(), imageRef };
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
