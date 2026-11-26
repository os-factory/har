import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildOtelHookScopes,
  destinationAcceptsRepository,
  destinationAcceptsSignal,
  otelScopesAllow,
  repositoryKey,
  resolveRepositoryReference,
} from '../src/core/destination-scopes';
import {
  alignHqDestinationAfterLogin,
  chooseHqRepositories,
  defaultHqScope,
  hqRepositoryCandidates,
  listHqRepositories,
  removeHqRepositories,
} from '../src/core/hq-repositories';
import { ingestReceiversFor } from '../src/core/ingest-publish';
import { buildOtelHooksConfig, type OtelHookFeatures } from '../src/core/otel-hooks';
import { writeTelemetryLevel } from '../src/core/telemetry-config';
import {
  buildHqDestination,
  buildMissionControlDestination,
  materializeOtlpDestinations,
  readDestinations,
  writeDestinations,
} from '../src/core/telemetry-destinations';
import type { HarDestination } from '../src/harness/schema';

/** HAR HQ is opt-in per repository: what each repository sends, on every channel. */

let tmp: string;
const savedEnv = { ...process.env };

function gitRepo(name: string, remote?: string): string {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  execSync('git init -q', { cwd: dir });
  if (remote) execSync(`git remote add origin ${remote}`, { cwd: dir });
  return dir;
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'har-scopes-')));
  process.env.HAR_DESTINATIONS_DIR = path.join(tmp, 'destinations');
  process.env.HAR_TELEMETRY_CONFIG_PATH = path.join(tmp, 'telemetry.json');
  process.env.HAR_HQ_INGEST_URL = 'https://receiver.example.com/ingest';
  process.env.HAR_PORTAL_TOKEN = 'hq-key';
  delete process.env.HAR_TELEMETRY;
  process.env.HAR_CONTROL_DISABLED = 'true';
});

afterEach(() => {
  process.env = { ...savedEnv };
  fs.rmSync(tmp, { recursive: true, force: true });
});

const hq = (repositories?: HarDestination['repositories']): HarDestination => ({
  ...buildHqDestination({ baseUrl: 'https://receiver.example.com/ingest' }),
  ...(repositories ? { repositories } : {}),
});

describe('repositoryKey', () => {
  it('normalizes every spelling of a remote the way otel-hook does', () => {
    for (const spelling of [
      'https://GitHub.com/Acme/App.git',
      'https://user:secret@github.com/acme/app/',
      'git@github.com:acme/app.git',
      'ssh://git@github.com:22/acme/app',
      'github.com/acme/app',
    ]) {
      expect(repositoryKey(spelling)).toBe('github.com/acme/app');
    }
    expect(repositoryKey('/home/me/app')).toBeUndefined();
    expect(repositoryKey('file:///home/me/app')).toBeUndefined();
  });
});

describe('otel-hook scopes', () => {
  it('maps off / usage / outline / full and the content choice; groups equal scopes', () => {
    const scopes = buildOtelHookScopes(
      hq([
        { url: 'https://example.test/a/off.git', scope: 'off' },
        { url: 'https://example.test/a/usage.git', scope: 'usage' },
        { url: 'https://example.test/a/usage2.git', scope: 'usage' },
        { url: 'https://example.test/a/outline.git', scope: 'outline' },
        { url: 'https://example.test/a/redacted.git', scope: 'full', content: 'redacted' },
        { url: 'https://example.test/a/masked.git', scope: 'full', content: 'masked' },
        { url: 'https://example.test/a/raw.git', scope: 'full', content: 'raw' },
        { url: 'https://example.test/a/fullnone.git', scope: 'full' },
        { path: '/no/remote', scope: 'full', content: 'raw' },
      ]),
    );
    expect(scopes).toEqual([
      { repositories: ['example.test/a/usage', 'example.test/a/usage2'], signals: ['traces', 'metrics'], contentMode: 'omit' },
      {
        repositories: ['example.test/a/outline', 'example.test/a/fullnone'],
        signals: ['traces', 'logs', 'metrics'],
        contentMode: 'omit',
      },
      { repositories: ['example.test/a/redacted'], signals: ['traces', 'logs', 'metrics'], contentMode: 'redact' },
      { repositories: ['example.test/a/masked'], signals: ['traces', 'logs', 'metrics'], contentMode: 'mask' },
      { repositories: ['example.test/a/raw'], signals: ['traces', 'logs', 'metrics'], contentMode: 'raw' },
    ]);
  });

  it('an hq destination is always scoped: no repositories → nothing; other destinations stay unscoped', () => {
    expect(buildOtelHookScopes(hq())).toEqual([]);
    expect(buildOtelHookScopes(buildMissionControlDestination())).toBeUndefined();
    const narrowed = { ...hq([{ url: 'https://example.test/a/b', scope: 'full', content: 'raw' }]), signals: ['traces' as const] };
    expect(buildOtelHookScopes(narrowed)?.[0].signals).toEqual(['traces']);
    const noSession = { ...hq([{ url: 'https://example.test/a/b', scope: 'usage' }]), includeSessionId: false };
    expect(buildOtelHookScopes(noSession)?.[0].includeSessionId).toBe(false);
  });

  it('materializes no OTLP destination for an hq with nothing chosen, and the scopes otherwise', () => {
    writeDestinations({ version: 2, destinations: [hq()] });
    expect(materializeOtlpDestinations(readDestinations())).toEqual([]);
    writeDestinations({ version: 2, destinations: [hq([{ url: 'https://example.test/a/b.git', scope: 'usage' }])] });
    expect(materializeOtlpDestinations(readDestinations())[0].scopes).toEqual([
      { repositories: ['example.test/a/b'], signals: ['traces', 'metrics'], contentMode: 'omit' },
    ]);
  });

  it('never writes a scoped destination for an otel-hook that cannot filter by repository', () => {
    writeTelemetryLevel('full');
    const scoped = materializeOtlpDestinations({
      version: 2,
      destinations: [hq([{ url: 'https://example.test/a/b.git', scope: 'full', content: 'raw' }])],
    });
    const route = { mode: 'fanout' as const, missionControl: 'http://mc.test', destinations: scoped };
    const features: OtelHookFeatures = { destinations: true, transcriptUsage: true, metrics: true, sessionContext: true, scopes: false };
    expect(buildOtelHooksConfig({ route, features }).exporter.destinations?.map((d) => d.name)).toEqual(['mission-control']);
    const withScopes = buildOtelHooksConfig({ route, features: { ...features, scopes: true } });
    expect(withScopes.exporter.destinations?.map((d) => [d.name, d.scopes?.[0].contentMode])).toEqual([
      ['mission-control', undefined],
      ['hq', 'raw'],
    ]);
    // Mission Control keeps the raw text: the scope only restricts the hosted copy.
    expect(withScopes.privacy.contentMode).toBe('raw');
  });

  it('applies the same rule to HAR’s own OTLP (verification traces)', () => {
    const scopes = [{ repositories: ['example.test/a/b'], signals: ['traces' as const, 'metrics' as const] }];
    expect(otelScopesAllow(undefined, undefined, 'traces')).toBe(true);
    expect(otelScopesAllow(scopes, 'git@example.test:a/b.git', 'traces')).toBe(true);
    expect(otelScopesAllow(scopes, 'https://example.test/a/b', 'logs')).toBe(false);
    expect(otelScopesAllow(scopes, 'https://example.test/a/other', 'traces')).toBe(false);
    expect(otelScopesAllow(scopes, undefined, 'traces')).toBe(false);
  });
});

describe('records, proofs and evidence', () => {
  it('go to a scoped receiver only for a chosen repository above off; never without a repository', () => {
    const chosen = gitRepo('chosen', 'https://example.test/acme/chosen.git');
    const other = gitRepo('other', 'https://example.test/acme/other.git');
    const muted = gitRepo('muted', 'https://example.test/acme/muted.git');
    const destination = hq([
      { path: chosen, url: 'https://example.test/acme/chosen.git', scope: 'usage' },
      { path: muted, url: 'https://example.test/acme/muted.git', scope: 'off' },
    ]);
    const destinations = [buildMissionControlDestination(), destination];
    const names = (repoPath?: string) =>
      ingestReceiversFor('records', { destinations, ...(repoPath ? { repoPath } : {}) }).map((d) => d.name);
    expect(names(chosen)).toContain('hq');
    // A harness in a subdirectory belongs to its repository.
    fs.mkdirSync(path.join(chosen, 'control'));
    expect(names(path.join(chosen, 'control'))).toContain('hq');
    expect(names(other)).not.toContain('hq');
    expect(names(muted)).not.toContain('hq');
    expect(names()).not.toContain('hq');
    // Matched by URL too (a clone elsewhere of the chosen repository).
    const clone = gitRepo('clone', 'git@example.test:acme/chosen.git');
    expect(destinationAcceptsRepository(destination, { repoPath: clone })).toBe(true);
    expect(destinationAcceptsSignal(destination, 'logs', { repoPath: chosen })).toBe(false);
    expect(destinationAcceptsSignal(destination, 'traces', { repoPath: chosen })).toBe(true);
  });
});

describe('choosing repositories', () => {
  it('adds the hq destination when missing, updates and removes entries, refuses a non-repository', () => {
    const app = gitRepo('app', 'https://example.test/acme/app.git');
    const reference = resolveRepositoryReference(app);
    expect(reference).toEqual({ path: app, url: 'https://example.test/acme/app.git' });
    expect(resolveRepositoryReference('git@example.test:acme/web.git')).toEqual({ url: 'ssh://example.test/acme/web.git' });
    expect(() => resolveRepositoryReference(path.join(tmp))).toThrow(/not inside a git repository/);

    const first = chooseHqRepositories([{ reference, scope: 'full', content: 'redacted' }]);
    expect(first.created).toBe(true);
    expect(listHqRepositories()).toEqual([{ path: app, url: 'https://example.test/acme/app.git', scope: 'full', content: 'redacted' }]);
    chooseHqRepositories([{ reference, scope: 'usage' }]);
    expect(listHqRepositories()).toEqual([{ path: app, url: 'https://example.test/acme/app.git', scope: 'usage' }]);
    expect(removeHqRepositories([{ url: 'https://example.test/acme/app' }])).toBe(1);
    expect(listHqRepositories()).toEqual([]);
  });

  it('a repository registered after login is not sent until chosen', () => {
    const app = gitRepo('app', 'https://example.test/acme/app.git');
    const later = gitRepo('later', 'https://example.test/acme/later.git');
    chooseHqRepositories([{ reference: resolveRepositoryReference(app), scope: 'usage' }]);
    const destination = readDestinations().destinations.find((d) => d.preset === 'hq')!;
    expect(destinationAcceptsRepository(destination, { repoPath: later })).toBe(false);
  });

  it('forgets the choices when the login switches org, keeps them otherwise', () => {
    const app = gitRepo('app', 'https://example.test/acme/app.git');
    chooseHqRepositories([{ reference: resolveRepositoryReference(app), scope: 'usage' }]);
    expect(alignHqDestinationAfterLogin({ switchedOrg: false })).toEqual([]);
    expect(listHqRepositories()).toHaveLength(1);
    expect(alignHqDestinationAfterLogin({ switchedOrg: true })).toHaveLength(1);
    expect(listHqRepositories()).toEqual([]);
  });

  it('offers registered repositories with the current one, 1.x attachments and existing choices pre-selected', () => {
    const current = gitRepo('current', 'https://example.test/acme/current.git');
    const attached = gitRepo('attached', 'https://example.test/acme/attached.git');
    const plain = gitRepo('plain');
    const chosenOff = gitRepo('chosen-off', 'https://example.test/acme/off.git');
    chooseHqRepositories([{ reference: resolveRepositoryReference(chosenOff), scope: 'off' }]);
    const candidates = hqRepositoryCandidates(current, {
      registered: [plain, attached, chosenOff],
      attachedIn1x: [attached],
    });
    expect(candidates.map((c) => [path.basename(c.path), c.preselected, c.url !== undefined])).toEqual([
      ['current', true, true],
      ['plain', false, false],
      ['attached', true, true],
      ['chosen-off', false, true],
    ]);
  });

  it('pre-selects what 1.x sent, else usage', () => {
    expect(defaultHqScope(undefined)).toEqual({ scope: 'usage', content: 'none' });
    expect(defaultHqScope({ trajectoryForwarding: false })).toEqual({ scope: 'outline', content: 'none' });
    expect(defaultHqScope({ trajectoryForwarding: true })).toEqual({ scope: 'full', content: 'raw' });
  });
});
