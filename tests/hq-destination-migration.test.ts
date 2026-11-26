import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  applyHqTrajectoryChoice,
  getMigrationsPath,
  hqDestinationFinding,
  hqFullExperienceHint,
  hqSignalsFor,
  hqTrajectoryForwarding,
  migrateHqDestination,
  runHqDestinationMigration,
} from '../src/core/hq-destination-migration';
import { formatDoctorReport } from '../src/harness/doctor';
import { collectIngestHealth, withIngestHealth } from '../src/core/ingest-health';
import { connectPortal, disconnectPortal, writePortalConnectionTrajectoryPreference } from '../src/core/portal-targets';
import { addDestination, buildHqDestination, readDestinations, removeDestination } from '../src/core/telemetry-destinations';

/** 1.x → 2.0: a machine connected to the hosted receiver keeps sending there. */

let tmp: string;
let env: NodeJS.ProcessEnv;
const savedTargets = process.env.HAR_PORTAL_TARGETS_PATH;
const savedLevel = process.env.HAR_TELEMETRY;
const savedTrajectory = process.env.HAR_PORTAL_TRAJECTORY;

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'har-hq-migration-'));
  process.env.HAR_PORTAL_TARGETS_PATH = path.join(tmp, 'portal-targets.json');
  // The level and the forwarding choice come from the test, never from the real ~/.har.
  process.env.HAR_TELEMETRY = 'full';
  delete process.env.HAR_PORTAL_TRAJECTORY;
  env = {
    HAR_DESTINATIONS_DIR: path.join(tmp, 'destinations'),
    HAR_HQ_INGEST_URL: 'https://receiver.example.com/ingest',
    HAR_CONTROL_DISABLED: 'true',
  };
});

afterEach(() => {
  disconnectPortal();
  process.env.HAR_PORTAL_TARGETS_PATH = savedTargets;
  restore('HAR_TELEMETRY', savedLevel);
  restore('HAR_PORTAL_TRAJECTORY', savedTrajectory);
  fs.rmSync(tmp, { recursive: true, force: true });
});

function connect(trajectoryForwarding?: boolean): void {
  connectPortal({ portalUrl: 'https://portal.example.com', workspaceId: 'org_a', token: 'org-a-token' });
  if (trajectoryForwarding !== undefined) writePortalConnectionTrajectoryPreference(trajectoryForwarding);
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
    // Notice, then the one "full experience" hint (1.x default: no trajectory forwarding).
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/Added destination "hq"/);
    expect(lines[0]).toMatch(/trajectory not forwarded, as in 1\.x/);
    expect(lines[1]).toMatch(/Full experience: har control trajectory on$/);

    expect(runHqDestinationMigration(env, (line) => lines.push(line)).status).toBe('already-ran');
    expect(lines).toHaveLength(2);
    expect(hqEntries()).toHaveLength(1);
  });

  it('1.x without trajectory forwarding: traces and metrics only, never the trajectory (logs)', () => {
    connect(false);
    expect(migrateHqDestination(env).status).toBe('added');
    expect(hqEntries()[0].signals).toEqual(['traces', 'metrics']);
    expect(hqEntries()[0]).toMatchObject({ records: true, proofs: true, evidence: true });
    expect(JSON.parse(fs.readFileSync(getMigrationsPath(env), 'utf8')).migrations['hq-destination'].result).toBe(
      'added-without-trajectory',
    );
  });

  it('1.x with trajectory forwarding: the full preset, logs included, and no hint at level full', () => {
    connect(true);
    const lines: string[] = [];
    expect(runHqDestinationMigration(env, (line) => lines.push(line)).status).toBe('added');
    expect(hqEntries()[0].signals).toEqual(['traces', 'logs', 'metrics']);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(/not forwarded/);
  });

  it('HAR_PORTAL_TRAJECTORY overrides the saved choice, as in 1.x', () => {
    connect(false);
    expect(hqTrajectoryForwarding({ ...env, HAR_PORTAL_TRAJECTORY: 'true' })).toBe(true);
    expect(migrateHqDestination({ ...env, HAR_PORTAL_TRAJECTORY: '1' }).status).toBe('added');
    expect(hqEntries()[0].signals).toContain('logs');
  });

  it('hints at level full for a forwarding machine below full', () => {
    connect(true);
    process.env.HAR_TELEMETRY = 'usage';
    const lines: string[] = [];
    runHqDestinationMigration(env, (line) => lines.push(line));
    expect(lines[1]).toMatch(/telemetry level is usage.*Full experience: har telemetry on --level full$/);
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

describe('trajectory choice → hq destination', () => {
  const hq = () => buildHqDestination({ baseUrl: 'https://receiver.example.com/ingest', signals: hqSignalsFor(false) });

  it('turns logs on and off every hq destination, other signals kept', () => {
    connect(false);
    addDestination(hq(), { env });
    expect(applyHqTrajectoryChoice(true, { env })).toMatchObject({ status: 'updated' });
    expect(hqEntries()[0].signals).toEqual(['traces', 'metrics', 'logs']);
    expect(applyHqTrajectoryChoice(true, { env }).status).toBe('unchanged');
    expect(applyHqTrajectoryChoice(false, { env }).status).toBe('updated');
    expect(hqEntries()[0].signals).toEqual(['traces', 'metrics']);
  });

  it('adds a missing hq destination only when asked (connect), never re-adds otherwise', () => {
    connect(false);
    expect(applyHqTrajectoryChoice(true, { env }).status).toBe('absent');
    expect(hqEntries()).toHaveLength(0);
    expect(applyHqTrajectoryChoice(false, { env, addMissing: true }).status).toBe('added');
    expect(hqEntries()[0].signals).toEqual(['traces', 'metrics']);
    expect(applyHqTrajectoryChoice(true, { env: { ...env, HAR_HQ_INGEST_URL: '' }, addMissing: true }).status).toBe(
      'updated',
    );
  });

  it('reports no-base-url when the ingest URL is unknown', () => {
    expect(
      applyHqTrajectoryChoice(true, { env: { HAR_DESTINATIONS_DIR: env.HAR_DESTINATIONS_DIR, HAR_CONTROL_DISABLED: 'true' }, addMissing: true })
        .status,
    ).toBe('no-base-url');
  });
});

describe('full experience hint', () => {
  const withLogs = buildHqDestination({ baseUrl: 'https://receiver.example.com/ingest' });
  const withoutLogs = buildHqDestination({ baseUrl: 'https://receiver.example.com/ingest', signals: hqSignalsFor(false) });

  it('names the exact commands for what is missing', () => {
    expect(hqFullExperienceHint(env, [withLogs])).toBeUndefined();
    expect(hqFullExperienceHint(env, [withoutLogs])).toMatch(/Full experience: har control trajectory on$/);
    process.env.HAR_TELEMETRY = 'outline';
    expect(hqFullExperienceHint(env, [withLogs])).toMatch(/Full experience: har telemetry on --level full$/);
    expect(hqFullExperienceHint(env, [withoutLogs])).toMatch(
      /Full experience: har telemetry on --level full && har control trajectory on$/,
    );
  });

  it('says nothing without an enabled hq destination or with telemetry off', () => {
    expect(hqFullExperienceHint(env, [])).toBeUndefined();
    expect(hqFullExperienceHint(env, [{ ...withoutLogs, enabled: false }])).toBeUndefined();
    process.env.HAR_TELEMETRY = 'off';
    expect(hqFullExperienceHint(env, [withoutLogs])).toBeUndefined();
  });

  it('doctor prints it as a hint, never a warning', async () => {
    connect(false);
    const health = await collectIngestHealth({ env, destinations: [withoutLogs], controlAvailable: false });
    expect(health.hints).toEqual([expect.stringMatching(/har control trajectory on/)]);
    const report = withIngestHealth({ ok: true, contract: '1.0', checks: [], findings: [] }, health);
    expect(report.findings).toEqual([]);
    expect(report.ok).toBe(true);
    expect(formatDoctorReport(report)).toMatch(/^hint: The hosted receiver does not get the full trajectory \(trajectory forwarding is off\)/m);
  });
});
