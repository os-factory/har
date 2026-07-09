import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { computePreviewUrls } from '../src/core/local-executor';

const tmpDirs: string[] = [];

function makeHarness(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-ports-'));
  tmpDirs.push(dir);
  const harDir = path.join(dir, '.har');
  fs.mkdirSync(harDir, { recursive: true });
  fs.writeFileSync(
    path.join(harDir, 'harness.env'),
    [
      'export HARNESS_PROJECT_NAME=test-project',
      'export HARNESS_FE_BASE_PORT=3000',
      'export HARNESS_API_BASE_PORT=8000',
      'export HARNESS_PORT_STEP=10',
      'export HARNESS_HEALTH_CHECK_PATH=/health',
      'export HARNESS_AGENT_SLOT_MIN=1',
      'export HARNESS_AGENT_SLOT_MAX=3',
    ].join('\n') + '\n',
  );
  return dir;
}

function writeRegistryEntry(
  repo: string,
  agentId: number,
  overrides: Record<string, unknown> = {},
): void {
  const slotsDir = path.join(repo, '.har', 'slots');
  fs.mkdirSync(slotsDir, { recursive: true });
  fs.writeFileSync(
    path.join(slotsDir, `agent-${agentId}.json`),
    JSON.stringify({
      version: 1,
      agentId,
      projectName: 'test-project',
      mode: 'worktree',
      workDir: '/tmp/work',
      createdAt: new Date().toISOString(),
      status: 'active',
      ...overrides,
    }),
  );
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('computePreviewUrls', () => {
  it('prefers persisted previewUrls from the slot registry', () => {
    const repo = makeHarness();
    writeRegistryEntry(repo, 1, {
      previewUrls: {
        frontend: 'http://localhost:3999',
        api: 'http://localhost:8999',
      },
    });

    expect(computePreviewUrls(repo, 1)).toEqual({
      frontend: 'http://localhost:3999',
      api: 'http://localhost:8999',
    });
  });

  it('builds preview URLs from persisted ports when previewUrls absent', () => {
    const repo = makeHarness();
    writeRegistryEntry(repo, 2, {
      ports: { frontend: 3055, api: 8055, debug: 9220 },
    });

    expect(computePreviewUrls(repo, 2)).toEqual({
      frontend: 'http://localhost:3055',
      api: 'http://localhost:8055',
      health: 'http://localhost:8055/health',
    });
  });

  it('falls back to formula when no registry entry exists', () => {
    const repo = makeHarness();
    expect(computePreviewUrls(repo, 3)).toEqual({
      frontend: 'http://localhost:3030',
      api: 'http://localhost:8030',
      health: 'http://localhost:8030/health',
    });
  });
});

describe('shell PM2 naming helpers', () => {
  it('har_pm2_slot_prefix scopes PM2 names by project', () => {
    const script = path.join(process.cwd(), 'src/templates/har-boilerplate/agent-slot.sh');
    const out = execSync(
      `bash -c 'export HARNESS_PROJECT_NAME=control; source "${script}" >/dev/null 2>&1; har_pm2_slot_prefix 1'`,
      { encoding: 'utf8' },
    ).trim();
    expect(out).toBe('har-control-agent-1');
  });

  it('har_pm2_delete_regex only matches this harness agent slot', () => {
    const script = path.join(process.cwd(), 'src/templates/har-boilerplate/agent-slot.sh');
    const out = execSync(
      `bash -c 'export HARNESS_PROJECT_NAME=control; source "${script}" >/dev/null 2>&1; har_pm2_delete_regex 1'`,
      { encoding: 'utf8' },
    ).trim();
    expect(out).toBe('/^har-control-agent-1-/');
  });
});
