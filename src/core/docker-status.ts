/**
 * Docker availability detection.
 *
 * Docker is a hard requirement for HAR: Mission Control runs as a container
 * (`har control up`) and harness profiles start shared infrastructure through
 * Docker Compose (`.har/setup-infra.sh`). Onboarding surfaces the requirement
 * up front instead of failing later with a raw Docker error.
 */
import * as childProcess from 'child_process';
import { warn } from '../utils/logging';

/** Where to send users who do not have Docker yet. */
export const DOCKER_INSTALL_URL = 'https://docs.docker.com/get-started/get-docker/';

export interface DockerStatus {
  /** A `docker` executable is resolvable on PATH. */
  cliInstalled: boolean;
  /** The Docker daemon answered `docker info` (engine actually usable). */
  daemonRunning: boolean;
  /** Client version reported by `docker --version`, when parseable. */
  version?: string;
}

export interface DockerProbe {
  /** Returns the raw `docker --version` output, or null when the CLI is missing. */
  version: () => string | null;
  /** True when the Docker daemon answered. */
  daemon: () => boolean;
}

/** Fail fast so a hung daemon cannot stall onboarding or `har env init`. */
const VERSION_PROBE_MS = 1000;
const DAEMON_PROBE_MS = 2000;

function execDocker(args: string[], timeout: number): string | null {
  try {
    return childProcess.execFileSync('docker', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout,
      killSignal: 'SIGKILL',
    });
  } catch {
    return null;
  }
}

const defaultProbe: DockerProbe = {
  version: () => execDocker(['--version'], VERSION_PROBE_MS),
  daemon: () => execDocker(['info', '--format', '{{.ServerVersion}}'], DAEMON_PROBE_MS) !== null,
};

/** Parse `Docker version 27.3.1, build ce12230` → `27.3.1`. */
export function parseDockerVersion(raw: string | null): string | undefined {
  if (!raw) return undefined;
  const match = raw.match(/version\s+([^\s,]+)/i);
  return match ? match[1] : undefined;
}

let cached: DockerStatus | undefined;

/** Reset the memoized probe result (tests, long-lived processes). */
export function resetDockerStatusCache(): void {
  cached = undefined;
}

/**
 * Probe the local Docker installation. Memoized per process — pass
 * `refresh: true` (or a custom `probe`) to force a new probe.
 */
export function detectDockerStatus(
  options: { probe?: DockerProbe; refresh?: boolean } = {},
): DockerStatus {
  const probe = options.probe;
  if (!probe && !options.refresh && cached) return cached;

  const resolved = probe ?? defaultProbe;
  const raw = resolved.version();
  const status: DockerStatus = raw
    ? { cliInstalled: true, daemonRunning: resolved.daemon(), version: parseDockerVersion(raw) }
    : { cliInstalled: false, daemonRunning: false };

  if (!probe) cached = status;
  return status;
}

/** Docker is installed *and* the daemon answers. */
export function isDockerUsable(status: DockerStatus): boolean {
  return status.cliInstalled && status.daemonRunning;
}

/** One-line status for summaries. */
export function describeDockerStatus(status: DockerStatus): string {
  if (!status.cliInstalled) return 'not installed (required)';
  if (!status.daemonRunning) return `installed${status.version ? ` ${status.version}` : ''} but not running`;
  return `running${status.version ? ` (${status.version})` : ''}`;
}

/**
 * User-facing warning when Docker cannot be used. Returns null when Docker is
 * installed and the daemon is up.
 */
export function formatDockerRequirementWarning(status: DockerStatus): string | null {
  if (isDockerUsable(status)) return null;
  const why =
    'Docker is required by HAR — Mission Control runs as a container and harness infra uses Docker Compose.';
  if (!status.cliInstalled) {
    return `${why} No docker executable found on PATH. Install Docker: ${DOCKER_INSTALL_URL}`;
  }
  return `${why} Docker is installed but the daemon is not responding — start Docker Desktop (or the docker service) and re-run.`;
}

/**
 * Print the Docker requirement warning when Docker is unusable.
 * Returns the warning that was shown, or null when Docker is fine.
 */
export function warnIfDockerUnavailable(status: DockerStatus = detectDockerStatus()): string | null {
  const warning = formatDockerRequirementWarning(status);
  if (warning) warn(warning);
  return warning;
}
