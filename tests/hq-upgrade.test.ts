import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  HQ_LOGOUT_NOTICE,
  getMigrationsPath,
  hqLoginDefaults,
  hqStatusHint,
  migrateHqLogout,
  runHqUpgradeMigration,
} from '../src/core/hq-upgrade';
import { chooseHqRepositories } from '../src/core/hq-repositories';
import { collectIngestHealth, withIngestHealth } from '../src/core/ingest-health';
import {
  attachRepoToPortal,
  connectPortal,
  disconnectPortal,
  getActivePortalConnection,
  writePortalConnectionTrajectoryPreference,
} from '../src/core/portal-targets';
import { readDestinations } from '../src/core/telemetry-destinations';

/** 1.x → 2.0: a machine logged in to HAR HQ is logged out, and nothing is sent until it chooses repositories. */

let tmp: string;
let env: NodeJS.ProcessEnv;
const saved = {
  targets: process.env.HAR_PORTAL_TARGETS_PATH,
  credentials: process.env.HAR_CREDENTIALS_PATH,
  trajectory: process.env.HAR_PORTAL_TRAJECTORY,
  destinations: process.env.HAR_DESTINATIONS_DIR,
};

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'har-hq-upgrade-')));
  process.env.HAR_PORTAL_TARGETS_PATH = path.join(tmp, 'portal-targets.json');
  process.env.HAR_CREDENTIALS_PATH = path.join(tmp, 'credentials.json');
  process.env.HAR_DESTINATIONS_DIR = path.join(tmp, 'destinations');
  delete process.env.HAR_PORTAL_TRAJECTORY;
  env = {
    HAR_DESTINATIONS_DIR: path.join(tmp, 'destinations'),
    HAR_HQ_INGEST_URL: 'https://receiver.example.com/ingest',
    HAR_CONTROL_DISABLED: 'true',
  };
});

afterEach(() => {
  disconnectPortal();
  restore('HAR_PORTAL_TARGETS_PATH', saved.targets);
  restore('HAR_CREDENTIALS_PATH', saved.credentials);
  restore('HAR_PORTAL_TRAJECTORY', saved.trajectory);
  restore('HAR_DESTINATIONS_DIR', saved.destinations);
  fs.rmSync(tmp, { recursive: true, force: true });
});

function connect1x(options: { trajectory?: boolean; repos?: string[] } = {}): void {
  connectPortal({
    portalUrl: 'https://portal.example.com',
    workspaceId: 'org_a',
    workspaceName: 'Acme',
    token: 'org-a-token',
    email: 'dev@example.com',
  });
  for (const repo of options.repos ?? []) attachRepoToPortal(repo);
  if (options.trajectory !== undefined) writePortalConnectionTrajectoryPreference(options.trajectory);
}

function makeDir(name: string): string {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe('2.0 upgrade logs a 1.x HAR HQ login out', () => {
  it('removes the stored connection and tokens, adds no destination, prints one notice, once', () => {
    const repo = makeDir('app');
    connect1x({ repos: [repo] });
    const lines: string[] = [];

    const outcome = runHqUpgradeMigration(env, (line: string) => lines.push(line));

    expect(outcome.status).toBe('logged-out');
    expect(lines).toEqual([`[har] ${HQ_LOGOUT_NOTICE}`]);
    expect(lines[0]).toBe(
      '[har] HAR 2.0 sends to HAR HQ only for repositories you choose. Run `har hq connect` to log in again.',
    );
    expect(getActivePortalConnection()).toBeNull();
    expect(fs.readFileSync(process.env.HAR_PORTAL_TARGETS_PATH as string, 'utf8')).not.toContain('org-a-token');
    expect(fs.existsSync(process.env.HAR_CREDENTIALS_PATH as string)).toBe(false);
    expect(readDestinations(env).destinations.filter((d) => d.preset === 'hq')).toEqual([]);
    // The 1.x choices are kept, only to pre-select at the next login.
    expect(hqLoginDefaults(env)).toEqual({
      portalUrl: 'https://portal.example.com',
      org: 'Acme @ portal.example.com',
      email: 'dev@example.com',
      repositories: [repo],
      trajectoryForwarding: false,
    });
    expect(fs.readFileSync(getMigrationsPath(env), 'utf8')).not.toContain('org-a-token');

    // A later login is never logged out again.
    connect1x();
    expect(runHqUpgradeMigration(env, (line: string) => lines.push(line)).status).toBe('already-ran');
    expect(lines).toHaveLength(1);
    expect(getActivePortalConnection()).not.toBeNull();
  });

  it('removes a 1.x credentials.json too', () => {
    fs.writeFileSync(
      process.env.HAR_CREDENTIALS_PATH as string,
      JSON.stringify({ portalUrl: 'https://portal.example.com', token: 'legacy-token' }),
    );
    expect(migrateHqLogout(env).status).toBe('logged-out');
    expect(fs.existsSync(process.env.HAR_CREDENTIALS_PATH as string)).toBe(false);
    expect(getActivePortalConnection()).toBeNull();
  });

  it('keeps the 1.x trajectory choice as a default', () => {
    connect1x({ trajectory: true });
    expect(migrateHqLogout(env)).toMatchObject({ status: 'logged-out', defaults: { trajectoryForwarding: true } });
  });

  it('records a machine that was not logged in, so a 2.0 login is never logged out later', () => {
    expect(migrateHqLogout(env).status).toBe('not-connected');
    connect1x();
    expect(migrateHqLogout(env).status).toBe('already-ran');
    expect(getActivePortalConnection()).not.toBeNull();
    expect(hqLoginDefaults(env)).toBeUndefined();
  });

  it('leaves HAR_PORTAL_TOKEN alone (nothing stored to remove)', () => {
    expect(migrateHqLogout({ ...env, HAR_PORTAL_TOKEN: 'ci-key' }).status).toBe('not-connected');
  });
});

describe('informational status line', () => {
  it('says the user was logged out until they log in again, then that nothing is chosen, then nothing', async () => {
    const repo = makeDir('app');
    connect1x({ repos: [repo] });
    migrateHqLogout(env);
    expect(hqStatusHint(env)).toMatch(/^Logged out of HAR HQ by the upgrade to 2\.0: .* har hq connect$/);

    // Doctor: a hint, never a warning or an error.
    const report = withIngestHealth(
      { ok: true, checks: [], findings: [] } as unknown as Parameters<typeof withIngestHealth>[0],
      await collectIngestHealth({ env }),
    );
    expect(report.findings).toEqual([]);
    expect(report.hints).toEqual([expect.stringMatching(/Logged out of HAR HQ/)]);

    connect1x();
    expect(hqStatusHint(env)).toMatch(/no repository is chosen/);
    chooseHqRepositories([{ reference: { path: repo, url: 'https://example.test/acme/app.git' }, scope: 'usage' }], env);
    expect(hqStatusHint(env)).toBeUndefined();
  });
});
