import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sanitizeGitRemoteUrl } from '../src/core/git-remote';
import { parseResourceAttributesString } from '../src/core/otel-hooks';
import {
  buildOtelResourceAttributes,
  buildTelemetryEnvBlock,
  withCorrelationDefaults,
  type TelemetrySessionAttrs,
} from '../src/core/telemetry-env';
import { upsertWorkUnit } from '../src/core/work-units';

// Telemetry-profile Resource attributes (#416) are emitted alongside har.*.
// The har.* contract itself is pinned in telemetry-contract-otel.test.ts.

const BASE: TelemetrySessionAttrs = {
  sessionKey: 'main-abcd-har-agent-1-xy12',
  agentId: 1,
  repoPath: '/repo',
  workDir: '/repo/wt',
  branch: 'main-abcd-har-agent-1-xy12',
  suffix: 'xy12',
  workUnitId: 'ISSUE-416',
  attemptId: '11111111-1111-4111-8111-111111111111',
};

function decode(raw: string): Record<string, string> {
  return parseResourceAttributesString(raw);
}

describe('factory.* / vcs.* resource attributes', () => {
  const originalVersion = process.env.HAR_PACKAGE_VERSION;
  beforeEach(() => {
    process.env.HAR_PACKAGE_VERSION = '2.0.0-test';
  });
  afterEach(() => {
    if (originalVersion === undefined) delete process.env.HAR_PACKAGE_VERSION;
    else process.env.HAR_PACKAGE_VERSION = originalVersion;
  });

  it('mirrors the har.* values under the semconv names', () => {
    const attrs = decode(
      buildOtelResourceAttributes({
        ...BASE,
        workUnitSource: 'github',
        repositoryUrl: 'https://github.com/example/fixture.git',
      }),
    );
    expect(attrs).toMatchObject({
      'factory.work_unit.id': attrs['har.work_unit_id'],
      'factory.work_unit.source': 'github',
      'factory.attempt.id': attrs['har.attempt_id'],
      'vcs.repository.url.full': 'https://github.com/example/fixture.git',
      'vcs.ref.head.name': attrs['har.branch'],
      'factory.producer.name': 'har',
      'factory.producer.version': '2.0.0-test',
    });
    expect(attrs['factory.work_unit.id']).toBe('ISSUE-416');
  });

  it('omits every attribute whose value is unknown, and never emits an empty value', () => {
    const attrs = decode(
      buildOtelResourceAttributes({
        sessionKey: 's1',
        agentId: 1,
        repoPath: '/r',
        workDir: '/r',
        branch: '',
        workUnitSource: '',
        repositoryUrl: '  ',
      }),
    );
    for (const key of [
      'factory.work_unit.id',
      'factory.work_unit.source',
      'factory.attempt.id',
      'vcs.repository.url.full',
      'vcs.ref.head.name',
    ]) {
      expect(attrs).not.toHaveProperty(key);
    }
    expect(attrs['factory.producer.name']).toBe('har');
    expect(Object.values(attrs)).not.toContain('');
  });

  it('uses the same encoding as har.* (, and = become _)', () => {
    const raw = buildOtelResourceAttributes({ ...BASE, branch: 'feat/a,b=c', workUnitSource: 'a,b' });
    const attrs = decode(raw);
    expect(attrs['vcs.ref.head.name']).toBe('feat/a_b_c');
    expect(attrs['vcs.ref.head.name']).toBe(attrs['har.branch']);
    expect(attrs['factory.work_unit.source']).toBe('a_b');
  });
});

describe('sanitizeGitRemoteUrl', () => {
  it.each([
    ['https://x-access-token:ghp_secret@github.com/org/repo.git', 'https://github.com/org/repo.git'],
    ['https://user@github.com/org/repo.git?token=abc#frag', 'https://github.com/org/repo.git'],
    ['ssh://git@github.com/org/repo.git', 'ssh://github.com/org/repo.git'],
    ['git@github.com:org/repo.git', 'ssh://github.com/org/repo.git'],
    ['https://github.com/org/repo', 'https://github.com/org/repo'],
  ])('%s → %s', (remote, expected) => {
    expect(sanitizeGitRemoteUrl(remote)).toBe(expected);
  });

  it.each([undefined, '', '/srv/git/repo.git', './relative/repo'])('drops %p', (remote) => {
    expect(sanitizeGitRemoteUrl(remote)).toBeUndefined();
  });
});

describe('agent env file correlation defaults', () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function makeRepo(remote?: string): string {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'har-semconv-'));
    tmpDirs.push(repo);
    fs.mkdirSync(path.join(repo, '.har'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, '.har', 'manifest.json'),
      JSON.stringify({ version: '1', createdAt: 'x', updatedAt: 'x' }),
    );
    execSync('git init -q', { cwd: repo });
    if (remote) execSync(`git remote add origin ${remote}`, { cwd: repo });
    return repo;
  }

  it('reads the origin remote without credentials and the work unit tracker', () => {
    const repo = makeRepo('https://x-access-token:ghp_secret@github.com/example/fixture.git');
    upsertWorkUnit(repo, { workUnitId: 'ISSUE-416', source: 'github' });

    const block = buildTelemetryEnvBlock({ ...BASE, repoPath: repo, workDir: repo });
    const line = block.split('\n').find((l) => l.startsWith('OTEL_RESOURCE_ATTRIBUTES=')) as string;
    const attrs = decode(line.slice('OTEL_RESOURCE_ATTRIBUTES='.length).replace(/^'|'$/g, ''));

    expect(attrs['vcs.repository.url.full']).toBe('https://github.com/example/fixture.git');
    expect(attrs['factory.work_unit.source']).toBe('github');
    expect(block).not.toContain('ghp_secret');
    expect(block).not.toContain('x-access-token');
  });

  it('omits the repository URL and tracker when there is no remote or no work unit record', () => {
    const repo = makeRepo();
    const filled = withCorrelationDefaults({ ...BASE, repoPath: repo, workDir: repo });
    expect(filled.repositoryUrl).toBeUndefined();
    expect(filled.workUnitSource).toBeUndefined();
    const attrs = decode(buildOtelResourceAttributes(filled));
    expect(attrs).not.toHaveProperty('vcs.repository.url.full');
    expect(attrs).not.toHaveProperty('factory.work_unit.source');
  });

  it('keeps values the caller passed', () => {
    const repo = makeRepo('https://github.com/example/other.git');
    const filled = withCorrelationDefaults({
      ...BASE,
      repoPath: repo,
      repositoryUrl: 'https://example.com/given.git',
      workUnitSource: 'linear',
    });
    expect(filled.repositoryUrl).toBe('https://example.com/given.git');
    expect(filled.workUnitSource).toBe('linear');
  });
});
