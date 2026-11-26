import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { DoctorFinding } from '../harness/doctor';
import { DESTINATION_PRESET_DEFAULTS, type HarDestination, type OtlpSignal } from '../harness/schema';
import { parseBoolean } from '../utils/parse-boolean';
import { getActivePortalConnection } from './portal-targets';
import { getTelemetryLevel, readTelemetryPreference } from './telemetry-config';
import {
  addDestination,
  buildHqDestination,
  defaultHqIngestBaseUrl,
  getDestinationsDir,
  readDestinations,
  resolveHqToken,
  writeDestinations,
} from './telemetry-destinations';

/**
 * 1.x → 2.0 upgrade: a machine connected to the hosted receiver (`har hq
 * connect`, or `HAR_PORTAL_TOKEN`) sent everything there through Mission
 * Control. 2.0 sends only to the destination list, so without an `hq` entry it
 * would silently stop. On the first run that sees a key, HAR adds the `hq`
 * destination with its preset defaults, once, and records that it did: a user
 * who removes it later is not re-added. Machines without a key are left alone
 * (and checked again on later runs, so connecting later still migrates).
 *
 * The migration never sends more than the user agreed to in 1.x. Forwarding
 * the trajectory to the hosted receiver was its own opt-in there
 * (`trajectoryForwarding` on the connection, off by default), while capturing
 * text is machine-wide. otel-hook's content switch is global too (one
 * `logs.includeContent` for every destination), so the only way to keep text
 * away from the hosted receiver is to leave the trajectory signal (OTLP logs)
 * off that destination: without the opt-in it gets traces and metrics (usage,
 * spans, stamps), with it the logs as well.
 */

export const MIGRATIONS_FILE = 'migrations.json';
export const HQ_DESTINATION_MIGRATION = 'hq-destination';

export type HqMigrationOutcome =
  | { status: 'added'; destination: HarDestination; notice: string; hint?: string }
  | { status: 'present' }
  | { status: 'already-ran' }
  | { status: 'no-token' }
  | { status: 'no-base-url'; notice: string }
  | { status: 'error'; notice: string };

interface MigrationsFile {
  version: 1;
  migrations: Record<string, { ranAt: string; result: string }>;
}

export function getMigrationsPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getDestinationsDir(env), MIGRATIONS_FILE);
}

function readMigrations(env: NodeJS.ProcessEnv): MigrationsFile {
  try {
    const raw = JSON.parse(fs.readFileSync(getMigrationsPath(env), 'utf8')) as Partial<MigrationsFile>;
    if (raw && typeof raw.migrations === 'object' && raw.migrations !== null) {
      return { version: 1, migrations: { ...raw.migrations } };
    }
  } catch {
    // Missing or unreadable: no migration recorded.
  }
  return { version: 1, migrations: {} };
}

function recordMigration(id: string, result: string, env: NodeJS.ProcessEnv): void {
  const file = readMigrations(env);
  file.migrations[id] = { ranAt: new Date().toISOString(), result };
  const target = getMigrationsPath(env);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, target);
}

export function hqMigrationRan(env: NodeJS.ProcessEnv = process.env): boolean {
  return readMigrations(env).migrations[HQ_DESTINATION_MIGRATION] !== undefined;
}

/**
 * Whether the user agreed to send the trajectory (prompts, replies, tool
 * output) to the hosted receiver: `HAR_PORTAL_TRAJECTORY`, else the saved
 * connection's `trajectoryForwarding` (`har hq connect`, `har control
 * trajectory on`), else the machine preference (`HAR_PORTAL_TOKEN` without a
 * saved connection). Off unless one of them says yes.
 */
export function hqTrajectoryForwarding(env: NodeJS.ProcessEnv = process.env): boolean {
  const override = parseBoolean(env.HAR_PORTAL_TRAJECTORY);
  if (override !== undefined) return override;
  try {
    const connection = getActivePortalConnection();
    if (connection) return connection.trajectoryForwarding === true;
    return readTelemetryPreference().portalTrajectory === true;
  } catch {
    return false;
  }
}

/** The signals an `hq` destination takes: the preset's, minus the trajectory (logs) without the opt-in. */
export function hqSignalsFor(forwardTrajectory: boolean): OtlpSignal[] {
  const defaults = DESTINATION_PRESET_DEFAULTS.hq.signals;
  return forwardTrajectory ? [...defaults] : defaults.filter((signal) => signal !== 'logs');
}

function withTrajectory(signals: readonly OtlpSignal[], forward: boolean): OtlpSignal[] {
  if (forward) return signals.includes('logs') ? [...signals] : [...signals, 'logs'];
  return signals.filter((signal) => signal !== 'logs');
}

export type HqTrajectoryApplyOutcome =
  | { status: 'updated' | 'unchanged'; destinations: HarDestination[] }
  | { status: 'added'; destinations: HarDestination[] }
  | { status: 'absent' }
  | { status: 'no-base-url' };

/**
 * Make the `hq` destinations follow the trajectory choice: logs on or off
 * every `hq` entry, other signals kept. With `addMissing` (`har hq connect`,
 * the user just connected) and no `hq` entry yet, add one. Throws on an
 * unreadable list.
 */
export function applyHqTrajectoryChoice(
  forward: boolean,
  options: { env?: NodeJS.ProcessEnv; addMissing?: boolean } = {},
): HqTrajectoryApplyOutcome {
  const env = options.env ?? process.env;
  const file = readDestinations(env);
  const hq = file.destinations.filter((destination) => destination.preset === 'hq');
  if (hq.length === 0) {
    if (!options.addMissing) return { status: 'absent' };
    const baseUrl = defaultHqIngestBaseUrl(env);
    if (!baseUrl) return { status: 'no-base-url' };
    const destination = buildHqDestination({ baseUrl, signals: hqSignalsFor(forward) });
    addDestination(destination, { env });
    return { status: 'added', destinations: [destination] };
  }
  let changed = false;
  const destinations = file.destinations.map((destination) => {
    if (destination.preset !== 'hq') return destination;
    const signals = withTrajectory(destination.signals, forward);
    if (signals.length === destination.signals.length) return destination;
    changed = true;
    return { ...destination, signals };
  });
  if (changed) writeDestinations({ ...file, destinations }, env);
  return {
    status: changed ? 'updated' : 'unchanged',
    destinations: destinations.filter((destination) => destination.preset === 'hq'),
  };
}

/**
 * "Propose the full experience": one line with the exact command when the
 * hosted receiver gets less than the full trajectory (no logs on its `hq`
 * destination, or a telemetry level below `full`). Undefined when there is no
 * enabled `hq` destination or nothing more to turn on. Never prompts.
 */
export function hqFullExperienceHint(
  env: NodeJS.ProcessEnv = process.env,
  destinations?: readonly HarDestination[],
): string | undefined {
  try {
    const list = destinations ?? readDestinations(env).destinations;
    const hq = list.filter((destination) => destination.preset === 'hq' && destination.enabled);
    if (hq.length === 0) return undefined;
    const level = getTelemetryLevel();
    if (level === 'off') return undefined;
    const needsLevel = level !== 'full';
    const needsLogs = !hq.every((destination) => destination.signals.includes('logs'));
    if (!needsLevel && !needsLogs) return undefined;
    const commands = [
      ...(needsLevel ? ['har telemetry on --level full'] : []),
      ...(needsLogs ? ['har control trajectory on'] : []),
    ];
    const reasons = [
      ...(needsLogs ? ['trajectory forwarding is off'] : []),
      ...(needsLevel ? [`telemetry level is ${level}`] : []),
    ];
    return `The hosted receiver does not get the full trajectory (${reasons.join(', ')}). Full experience: ${commands.join(' && ')}`;
  } catch {
    return undefined;
  }
}

/** Run the one-time `hq` destination migration. Never throws. */
export function migrateHqDestination(env: NodeJS.ProcessEnv = process.env): HqMigrationOutcome {
  try {
    if (hqMigrationRan(env)) return { status: 'already-ran' };
    if (!resolveHqToken(env)) return { status: 'no-token' };
    if (readDestinations(env).destinations.some((destination) => destination.preset === 'hq')) {
      recordMigration(HQ_DESTINATION_MIGRATION, 'present', env);
      return { status: 'present' };
    }
    const baseUrl = defaultHqIngestBaseUrl(env);
    if (!baseUrl) {
      return {
        status: 'no-base-url',
        notice:
          'A hosted receiver key is set but its ingest URL is unknown, so nothing is sent there: ' +
          'har telemetry destination add hq --preset hq --base-url <ingest base URL>',
      };
    }
    const forward = hqTrajectoryForwarding(env);
    const destination = buildHqDestination({ baseUrl, signals: hqSignalsFor(forward) });
    addDestination(destination, { env });
    recordMigration(HQ_DESTINATION_MIGRATION, forward ? 'added' : 'added-without-trajectory', env);
    const hint = hqFullExperienceHint(env, [destination]);
    return {
      status: 'added',
      destination,
      notice:
        `Added destination "${destination.name}" (hosted receiver, ${baseUrl}, ${destination.signals.join(', ')}` +
        `${forward ? '' : '; trajectory not forwarded, as in 1.x'}): 2.0 sends only to configured destinations. ` +
        `Remove it with: har telemetry destination remove ${destination.name}`,
      ...(hint ? { hint } : {}),
    };
  } catch (err) {
    return {
      status: 'error',
      notice: `Could not add the hosted receiver destination: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** One stderr line when the migration did something the user should know about. */
export function runHqDestinationMigration(
  env: NodeJS.ProcessEnv = process.env,
  write: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): HqMigrationOutcome {
  const outcome = migrateHqDestination(env);
  // `no-base-url` stays quiet here (it would repeat on every command); doctor reports it.
  if (outcome.status === 'added' || outcome.status === 'error') {
    write(`[har] ${outcome.notice}`);
  }
  if (outcome.status === 'added' && outcome.hint) write(`[har] ${outcome.hint}`);
  return outcome;
}

/**
 * Doctor: a hosted receiver key is set but no `hq` destination is configured
 * (or all are disabled), so nothing reaches the hosted receiver.
 */
export function hqDestinationFinding(
  env: NodeJS.ProcessEnv = process.env,
  destinations?: readonly HarDestination[],
): DoctorFinding | undefined {
  try {
    if (!resolveHqToken(env)) return undefined;
    const list = destinations ?? readDestinations(env).destinations;
    const hq = list.filter((destination) => destination.preset === 'hq');
    if (hq.some((destination) => destination.enabled)) return undefined;
    return {
      check: 'ingest-destinations',
      severity: 'warning',
      message:
        hq.length === 0
          ? 'A hosted receiver key is set (har hq connect / HAR_PORTAL_TOKEN) but no hq destination is configured: nothing is sent there.'
          : 'A hosted receiver key is set but every hq destination is disabled: nothing is sent there.',
      remedy:
        hq.length === 0
          ? 'har telemetry destination add hq --preset hq   (or har hq disconnect if that is intended)'
          : `har telemetry destination add ${hq[0].name} --preset hq --overwrite`,
    };
  } catch {
    return undefined;
  }
}
