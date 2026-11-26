import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  getMigrationsPath,
  hqDestinationFinding,
  migrateHqDestination,
  runHqDestinationMigration,
} from '../src/core/hq-destination-migration';
import { collectIngestHealth, withIngestHealth } from '../src/core/ingest-health';
import { connectPortal, disconnectPortal } from '../src/core/portal-targets';
import { addDestination, buildHqDestination, readDestinations, removeDestination } from '../src/core/telemetry-destinations';

/** 1.x → 2.0: a machine connected to the hosted receiver keeps sending there. */

let tmp: string;
let env: NodeJS.ProcessEnv;
const savedTargets = process.env.HAR_PORTAL_TARGETS_PATH;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'har-hq-migration-'));
  process.env.HAR_PORTAL_TARGETS_PATH = path.join(tmp, 'portal-targets.json');
  env = {
    HAR_DESTINATIONS_DIR: path.join(tmp, 'destinations'),
    HAR_HQ_INGEST_URL: 'https://receiver.example.com/ingest',
    HAR_CONTROL_DISABLED: 'true',
  };
});

afterEach(() => {
  disconnectPortal();
  process.env.HAR_PORTAL_TARGETS_PATH = savedTargets;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function connect(): void {
  connectPortal({ portalUrl: 'https://portal.example.com', workspaceId: 'org_a', token: 'org-a-token' });
}

function hqEntries() {
  return readDestinations(env).destinations.filter((destination) => destination.preset === 'hq');
}

describe('hq destination migration', () => {
  it('adds the hq destination once for a connected machine, with a notice', () => {
    connect();
    const lines: string[] = [];
    const outcome = runHqDestinationMigration(env, (line) => lines.push(line));
    expect(outcome.status).toBe('added');
    expect(hqEntries()).toEqual([
      expect.objectContaining({
        name: 'hq',
        enabled: true,
        baseUrl: 'https://receiver.example.com/ingest',
        auth: { kind: 'hq-token' },
      }),
    ]);
    // The key is read at send time, never stored in the list.
    expect(fs.readFileSync(path.join(tmp, 'destinations', 'destinations.json'), 'utf8')).not.toContain('org-a-token');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/Added destination "hq"/);

    expect(runHqDestinationMigration(env, (line) => lines.push(line)).status).toBe('already-ran');
    expect(lines).toHaveLength(1);
    expect(hqEntries()).toHaveLength(1);
  });

  it('does not re-add a destination the user removed', () => {
    connect();
    expect(migrateHqDestination(env).status).toBe('added');
    removeDestination('hq', env);
    expect(migrateHqDestination(env).status).toBe('already-ran');
    expect(hqEntries()).toHaveLength(0);
  });

  it('leaves machines without a key alone, and migrates once they connect', () => {
    expect(migrateHqDestination(env).status).toBe('no-token');
    expect(fs.existsSync(getMigrationsPath(env))).toBe(false);
    expect(hqEntries()).toHaveLength(0);
    connect();
    expect(migrateHqDestination(env).status).toBe('added');
  });

  it('records an existing hq destination without touching it', () => {
    connect();
    addDestination(buildHqDestination({ name: 'hosted', baseUrl: 'https://custom.example.com/ingest' }), { env });
    expect(migrateHqDestination(env).status).toBe('present');
    expect(hqEntries().map((destination) => destination.name)).toEqual(['hosted']);
    expect(migrateHqDestination(env).status).toBe('already-ran');
  });

  it('takes HAR_PORTAL_TOKEN as a key too; without an ingest URL it adds nothing and stays quiet', () => {
    const lines: string[] = [];
    const noUrl = { HAR_DESTINATIONS_DIR: env.HAR_DESTINATIONS_DIR, HAR_PORTAL_TOKEN: 'k', HAR_CONTROL_DISABLED: 'true' };
    expect(runHqDestinationMigration(noUrl, (line) => lines.push(line)).status).toBe('no-base-url');
    expect(lines).toEqual([]);
    expect(fs.existsSync(getMigrationsPath(env))).toBe(false);
    expect(migrateHqDestination({ ...noUrl, HAR_HQ_INGEST_URL: env.HAR_HQ_INGEST_URL }).status).toBe('added');
  });
});

describe('doctor: hosted receiver key without an hq destination', () => {
  it('warns when a key is set and no hq destination is configured or enabled', async () => {
    connect();
    const missing = hqDestinationFinding(env, []);
    expect(missing).toMatchObject({ check: 'ingest-destinations', severity: 'warning' });
    expect(missing!.remedy).toContain('har telemetry destination add hq --preset hq');

    const disabled = buildHqDestination({ baseUrl: 'https://receiver.example.com/ingest', enabled: false });
    expect(hqDestinationFinding(env, [disabled])!.message).toMatch(/disabled/);
    expect(hqDestinationFinding(env, [{ ...disabled, enabled: true }])).toBeUndefined();

    const health = await collectIngestHealth({ env, destinations: [] });
    const report = withIngestHealth({ pass: true, checks: [], findings: [] } as never, health);
    expect(report.findings).toEqual([expect.objectContaining({ check: 'ingest-destinations', severity: 'warning' })]);
    expect(report.checks.at(-1)).toMatchObject({ id: 'ingest-destinations', status: 'warn' });
  });

  it('says nothing without a key', () => {
    disconnectPortal();
    expect(hqDestinationFinding(env, [])).toBeUndefined();
  });
});
