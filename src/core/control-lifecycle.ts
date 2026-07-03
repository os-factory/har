import { spawnSync } from 'child_process';
import * as path from 'path';
import { getControlApiUrl, isControlEnabled } from './control-config';
import { syncAllKnownReposWithControl, waitForControlApi } from './control-sync';

export function resolveControlDir(): string {
  // dist/index.js → repo root/control (source install) or sibling when bundled
  return path.resolve(__dirname, '..', 'control');
}

export function runDockerCompose(args: string[]): number {
  const controlDir = resolveControlDir();
  const composeFile = path.join(controlDir, 'docker-compose.yml');
  const result = spawnSync('docker', ['compose', '-f', composeFile, ...args], {
    cwd: controlDir,
    stdio: 'inherit',
  });
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1;
}

export async function startMissionControl(options: {
  detach?: boolean;
}): Promise<{ code: number; apiUrl: string }> {
  const detach = options.detach !== false;
  const code = runDockerCompose(detach ? ['up', '-d'] : ['up']);
  return { code, apiUrl: getControlApiUrl() };
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
  cwd?: string;
}): Promise<{
  code: number;
  apiUrl: string;
  synced: number;
  failed: number;
  apiReady: boolean;
}> {
  const { code, apiUrl } = await startMissionControl({ detach: options?.detach });
  if (code !== 0) {
    return { code, apiUrl, synced: 0, failed: 0, apiReady: false };
  }

  const { synced, failed, apiReady } = await syncReposAfterControlStart(options?.cwd ?? process.cwd());
  return { code, apiUrl, synced, failed, apiReady };
}
