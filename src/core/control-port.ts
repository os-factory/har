/**
 * Port coordination with `har control up` — the customer-facing Docker CLI command.
 * Not tied to this monorepo's internal control/.har; any PM2 harness can hit the same
 * host port if they run `har control up` alongside `har env launch`.
 */
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getControlApiUrl } from './control-config';
import { readSlotRegistry } from './slot-registry';
import { isPortInUse } from './slot-ports';

export interface DockerRow {
  name: string;
  ports: string;
}

/** Host port Mission Control binds (from HAR_CONTROL_API_URL or default 3847). */
export function parseControlHostPort(apiUrl = getControlApiUrl()): number {
  try {
    const url = new URL(apiUrl);
    if (url.port) return Number(url.port);
    return url.protocol === 'https:' ? 443 : 80;
  } catch {
    return 3847;
  }
}

export function portPublishedInDocker(ports: string, port: number): boolean {
  const re = new RegExp(`:${port}->|:${port}/`);
  return re.test(ports) || ports.includes(`0.0.0.0:${port}`);
}

export function dockerOnPort(containers: DockerRow[], port: number): DockerRow | undefined {
  return containers.find((c) => portPublishedInDocker(c.ports, port));
}

/** Docker container from `har control up` publishing the given host port. */
export function controlContainerOnPort(containers: DockerRow[], port: number): DockerRow | undefined {
  return containers.find(
    (c) => /control/i.test(c.name) && portPublishedInDocker(c.ports, port),
  );
}

export function listDockerContainers(): DockerRow[] {
  try {
    const raw = execSync('docker ps --format {{.Names}}\\t{{.Ports}}', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 3000,
    });
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const tab = line.indexOf('\t');
        if (tab === -1) return { name: line, ports: '' };
        return { name: line.slice(0, tab), ports: line.slice(tab + 1) };
      });
  } catch {
    return [];
  }
}

export function formatControlPortBlocker(containerName: string, port: number, label?: string): string {
  const suffix = label ? ` (${label})` : '';
  return `har control up (container "${containerName}") occupies port ${port}${suffix}.`;
}

export function formatControlDefaultPortWarning(
  containerName: string,
  defaultPort: number,
  allocatedPort: number,
): string {
  return (
    `har control up holds port ${defaultPort} (container "${containerName}"). ` +
    `Harness will use port ${allocatedPort} instead. Run har control down to reclaim the default port.`
  );
}

/** Warn when har control up holds the slot default but launch proceeds on an alternate port. */
export function controlDefaultPortWarnings(
  containers: DockerRow[],
  defaultFrontendPort: number,
  allocatedFrontend: number,
): string[] {
  if (allocatedFrontend === defaultFrontendPort) return [];
  const control = controlContainerOnPort(containers, defaultFrontendPort);
  if (!control) return [];
  return [formatControlDefaultPortWarning(control.name, defaultFrontendPort, allocatedFrontend)];
}

export interface ControlUpReadiness {
  warnings: string[];
  portInUse: boolean;
  controlAlreadyRunning: boolean;
  harnessSlot1Active: boolean;
}

/**
 * Preflight for `har control up` — surfaces port 3847 conflicts with the control harness.
 */
export function inspectControlUpReadiness(repoPath: string): ControlUpReadiness {
  const resolved = path.resolve(repoPath);
  const port = parseControlHostPort();
  const containers = listDockerContainers();
  const control = controlContainerOnPort(containers, port);
  const warnings: string[] = [];

  const controlHarnessDir = path.join(resolved, 'control', '.har');
  const harnessSlot1Active =
    fs.existsSync(controlHarnessDir) &&
    readSlotRegistry(path.join(resolved, 'control'), 1)?.status === 'active';

  if (control) {
    return {
      warnings,
      portInUse: true,
      controlAlreadyRunning: true,
      harnessSlot1Active,
    };
  }

  if (harnessSlot1Active) {
    warnings.push(
      `Mission Control harness slot 1 is active under control/.har (port ${port}). ` +
        'Stop it with: cd control && har env teardown 1 — or use har control up only when the harness is down.',
    );
  }

  const portBusy = isPortInUse(port);
  if (portBusy) {
    const occupant = dockerOnPort(containers, port);
    const who = occupant ? `container "${occupant.name}"` : 'another process';
    warnings.push(
      `Port ${port} is already in use by ${who}. har control up needs this port — free it first.`,
    );
  }

  return {
    warnings,
    portInUse: portBusy,
    controlAlreadyRunning: false,
    harnessSlot1Active,
  };
}
