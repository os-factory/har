import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { DoctorFinding } from '../harness/doctor';
import type { HarDestination } from '../harness/schema';
import {
  addDestination,
  buildHqDestination,
  defaultHqIngestBaseUrl,
  getDestinationsDir,
  readDestinations,
  resolveHqToken,
} from './telemetry-destinations';

/**
 * 1.x → 2.0 upgrade: a machine connected to the hosted receiver (`har hq
 * connect`, or `HAR_PORTAL_TOKEN`) sent everything there through Mission
 * Control. 2.0 sends only to the destination list, so without an `hq` entry it
 * would silently stop. On the first run that sees a key, HAR adds the `hq`
 * destination with its preset defaults, once, and records that it did: a user
 * who removes it later is not re-added. Machines without a key are left alone
 * (and checked again on later runs, so connecting later still migrates).
 */

export const MIGRATIONS_FILE = 'migrations.json';
export const HQ_DESTINATION_MIGRATION = 'hq-destination';

export type HqMigrationOutcome =
  | { status: 'added'; destination: HarDestination; notice: string }
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
    const destination = buildHqDestination({ baseUrl });
    addDestination(destination, { env });
    recordMigration(HQ_DESTINATION_MIGRATION, 'added', env);
    return {
      status: 'added',
      destination,
      notice: `Added destination "${destination.name}" (hosted receiver, ${baseUrl}): 2.0 sends only to configured destinations. Remove it with: har telemetry destination remove ${destination.name}`,
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
