import { planSlotDatabaseSteps } from '../src/runtime/slot-database';

/** #345: HARNESS_DB_SEED_CMD must run per slot when no shared db service seeds a template. */
describe('planSlotDatabaseSteps (#345)', () => {
  const sqliteEnv = {
    HARNESS_INFRA_SERVICES: '',
    HARNESS_DB_MIGRATE_CMD: 'npx prisma db push',
    HARNESS_DB_SEED_CMD: 'node scripts/seed-dev-data.cjs',
  };

  it('migrates then seeds a file-backed database at launch', () => {
    const steps = planSlotDatabaseSteps(sqliteEnv, 'pm2');
    expect(steps.map((s) => s.what)).toEqual(['migrate', 'seed']);
    expect(steps[0].label).toBe('Applying database schema: npx prisma db push');
    expect(steps[1]).toMatchObject({
      envVar: 'HARNESS_DB_SEED_CMD',
      label: 'Running seeds: node scripts/seed-dev-data.cjs',
    });
  });

  it('does not seed again per slot when the Postgres template is seeded once', () => {
    const steps = planSlotDatabaseSteps({ ...sqliteEnv, HARNESS_INFRA_SERVICES: 'db redis' }, 'pm2');
    expect(steps.map((s) => s.what)).toEqual(['migrate']);
  });

  it('skips unset commands and the simulator profile entirely', () => {
    expect(planSlotDatabaseSteps({ ...sqliteEnv, HARNESS_DB_SEED_CMD: '' }, 'pm2').map((s) => s.what)).toEqual(['migrate']);
    expect(planSlotDatabaseSteps({ HARNESS_DB_SEED_CMD: 'seed' }, 'pm2').map((s) => s.what)).toEqual(['seed']);
    expect(planSlotDatabaseSteps(sqliteEnv, 'simulator')).toEqual([]);
  });
});
