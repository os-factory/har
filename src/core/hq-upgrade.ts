import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { parseBoolean } from '../utils/parse-boolean';
import { hqDestination } from './hq-repositories';
import { disconnectPortal, displayPortalTargetLabel, readPortalConnectionState } from './portal-targets';
import { readTelemetryPreference } from './telemetry-config';
import { getDestinationsDir, readDestinations, resolveHqToken } from './telemetry-destinations';

/**
 * 1.x → 2.0 upgrade of a machine connected to HAR HQ.
 *
 * In 1.x a connection sent every attached repository to HAR HQ. In 2.0 HAR HQ
 * is opt-in per repository, at a scope the user picks (`har hq connect`), so
 * the upgrade logs the user out: on the first 2.0 run that finds a 1.x
 * connection, HAR removes the stored connection and its tokens, adds no
 * destination, prints one notice, and records that it ran (a later login is
 * never logged out again). The 1.x attached repositories and trajectory choice
 * are kept in the record, only to pre-select them at the next login.
 *
 * `HAR_PORTAL_TOKEN` (no stored connection) is left alone: nothing is stored
 * to remove, and an `hq` destination sends only the repositories it lists.
 */

export const MIGRATIONS_FILE = 'migrations.json';
/** Migration id: the 2.0 upgrade logged a 1.x HAR HQ connection out. */
export const HQ_LOGOUT_MIGRATION = 'hq-logout-2-0';

/** The notice printed once, by the run that logs the user out. */
export const HQ_LOGOUT_NOTICE =
  'HAR 2.0 sends to HAR HQ only for repositories you choose. Run `har hq connect` to log in again.';

/** What 1.x had chosen, kept to pre-select at the next login. */
export interface HqLoginDefaults {
  portalUrl?: string;
  org?: string;
  email?: string;
  /** Repositories attached to the 1.x connection (canonical paths). */
  repositories: string[];
  /** 1.x forwarded the full trajectory (prompts, replies, tool output). */
  trajectoryForwarding: boolean;
}

interface MigrationEntry {
  ranAt: string;
  result: string;
  defaults?: HqLoginDefaults;
}

interface MigrationsFile {
  version: 1;
  migrations: Record<string, MigrationEntry>;
}

export type HqUpgradeOutcome =
  | { status: 'logged-out'; notice: string; defaults: HqLoginDefaults }
  | { status: 'not-connected' }
  | { status: 'already-ran' }
  | { status: 'error'; notice: string };

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

function recordMigration(id: string, entry: Omit<MigrationEntry, 'ranAt'>, env: NodeJS.ProcessEnv): void {
  const file = readMigrations(env);
  file.migrations[id] = { ranAt: new Date().toISOString(), ...entry };
  const target = getMigrationsPath(env);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, target);
}

function migrationEntry(env: NodeJS.ProcessEnv): MigrationEntry | undefined {
  return readMigrations(env).migrations[HQ_LOGOUT_MIGRATION];
}

export function hqUpgradeRan(env: NodeJS.ProcessEnv = process.env): boolean {
  return migrationEntry(env) !== undefined;
}

/** The 1.x choices kept by the logout, if the upgrade logged this machine out. */
export function hqLoginDefaults(env: NodeJS.ProcessEnv = process.env): HqLoginDefaults | undefined {
  const entry = migrationEntry(env);
  return entry?.result === 'logged-out' ? entry.defaults : undefined;
}

function trajectoryChoice(connectionChoice: boolean | undefined, env: NodeJS.ProcessEnv): boolean {
  const override = parseBoolean(env.HAR_PORTAL_TRAJECTORY);
  if (override !== undefined) return override;
  if (connectionChoice !== undefined) return connectionChoice;
  try {
    return readTelemetryPreference().portalTrajectory === true;
  } catch {
    return false;
  }
}

/** Run the one-time logout. Never throws, never prompts. */
export function migrateHqLogout(env: NodeJS.ProcessEnv = process.env): HqUpgradeOutcome {
  try {
    if (hqUpgradeRan(env)) return { status: 'already-ran' };
    // Also folds a 1.x `credentials.json` into the connection store, so both are removed below.
    const { connection, attachedRepos } = readPortalConnectionState();
    if (!connection) {
      recordMigration(HQ_LOGOUT_MIGRATION, { result: 'not-connected' }, env);
      return { status: 'not-connected' };
    }
    const defaults: HqLoginDefaults = {
      portalUrl: connection.portalUrl,
      org: displayPortalTargetLabel(connection),
      ...(connection.email ? { email: connection.email } : {}),
      repositories: [...attachedRepos],
      trajectoryForwarding: trajectoryChoice(connection.trajectoryForwarding, env),
    };
    // Record first: a crash between the two never logs a later login out.
    recordMigration(HQ_LOGOUT_MIGRATION, { result: 'logged-out', defaults }, env);
    disconnectPortal();
    return { status: 'logged-out', notice: HQ_LOGOUT_NOTICE, defaults };
  } catch (err) {
    return {
      status: 'error',
      notice: `Could not log out of HAR HQ for the 2.0 upgrade: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** The one stderr notice, from the run that logs the user out. */
export function runHqUpgradeMigration(
  env: NodeJS.ProcessEnv = process.env,
  write: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): HqUpgradeOutcome {
  const outcome = migrateHqLogout(env);
  if (outcome.status === 'logged-out' || outcome.status === 'error') write(`[har] ${outcome.notice}`);
  return outcome;
}

/**
 * Doctor / status line (informational, never a warning) when nothing reaches
 * HAR HQ for a reason the user may not know about: logged out by the 2.0
 * upgrade, or logged in with no repository chosen. Undefined otherwise.
 */
export function hqStatusHint(env: NodeJS.ProcessEnv = process.env): string | undefined {
  try {
    const token = resolveHqToken(env);
    if (!token) {
      return hqLoginDefaults(env)
        ? 'Logged out of HAR HQ by the upgrade to 2.0: nothing is sent there. Log in again and choose repositories: har hq connect'
        : undefined;
    }
    const hq = hqDestination(readDestinations(env).destinations);
    const chosen = (hq?.enabled ? (hq.repositories ?? []) : []).filter((entry) => entry.scope !== 'off');
    if (chosen.length > 0) return undefined;
    return 'Logged in to HAR HQ, but no repository is chosen: nothing is sent there. Choose: har hq repos add <repo> --scope usage';
  } catch {
    return undefined;
  }
}
