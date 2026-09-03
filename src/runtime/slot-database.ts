import { infraEnabled } from './infra';

export interface SlotDatabaseStep {
  /** harness.env variable holding the command; the shell evaluates it with the slot env sourced. */
  envVar: 'HARNESS_DB_MIGRATE_CMD' | 'HARNESS_DB_SEED_CMD';
  /** Log line prefix, e.g. `Applying database schema: npx prisma db push`. */
  label: string;
  command: string;
  /** Used in the launch error: `database <what> command failed (<code>)`. */
  what: 'migrate' | 'seed';
}

/**
 * Database steps launch runs per slot, in order (#345).
 *
 * - Schema (`HARNESS_DB_MIGRATE_CMD`) always runs per slot: with a shared Postgres
 *   service the slot database is cloned from the template, but code may have moved
 *   since the template was built; for file-backed databases it is the only schema step.
 * - Seeds (`HARNESS_DB_SEED_CMD`) run per slot ONLY when no shared `db` service is
 *   enabled. With Postgres the template database is seeded once in setup-infra and
 *   every slot clones it, so seeding again would duplicate rows.
 *
 * Simulator profiles have no database. Empty strings mean "not configured".
 */
export function planSlotDatabaseSteps(
  env: Record<string, string>,
  processManager: string,
): SlotDatabaseStep[] {
  if (processManager === 'simulator') return [];
  const steps: SlotDatabaseStep[] = [];
  if (env.HARNESS_DB_MIGRATE_CMD) {
    steps.push({
      envVar: 'HARNESS_DB_MIGRATE_CMD',
      label: `Applying database schema: ${env.HARNESS_DB_MIGRATE_CMD}`,
      command: env.HARNESS_DB_MIGRATE_CMD,
      what: 'migrate',
    });
  }
  if (env.HARNESS_DB_SEED_CMD && !infraEnabled(env, 'db')) {
    steps.push({
      envVar: 'HARNESS_DB_SEED_CMD',
      label: `Running seeds: ${env.HARNESS_DB_SEED_CMD}`,
      command: env.HARNESS_DB_SEED_CMD,
      what: 'seed',
    });
  }
  return steps;
}
