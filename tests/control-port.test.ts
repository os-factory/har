import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import {
  controlContainerOnPort,
  controlDefaultPortWarnings,
  dockerOnPort,
  formatControlPortBlocker,
  inspectControlUpReadiness,
  parseControlHostPort,
  portPublishedInDocker,
} from '../src/core/control-port';
import { inspectSlotReadiness } from '../src/core/slot-preflight';

describe('control-port helpers', () => {
  it('parseControlHostPort reads port from URL', () => {
    expect(parseControlHostPort('http://localhost:3847')).toBe(3847);
    expect(parseControlHostPort('http://localhost:3857/api')).toBe(3857);
  });

  it('detects published docker ports', () => {
    expect(portPublishedInDocker('0.0.0.0:3847->3847/tcp', 3847)).toBe(true);
    expect(portPublishedInDocker('0.0.0.0:3857->3847/tcp', 3847)).toBe(false);
  });

  it('finds control container on port', () => {
    const containers = [
      { name: 'control-app-1', ports: '0.0.0.0:3847->3847/tcp' },
      { name: 'har-other-db-1', ports: '0.0.0.0:15432->5432/tcp' },
    ];
    expect(controlContainerOnPort(containers, 3847)?.name).toBe('control-app-1');
    expect(dockerOnPort(containers, 15432)?.name).toBe('har-other-db-1');
  });

  it('builds control default port warning when alternate allocated', () => {
    const containers = [{ name: 'control-app-1', ports: '0.0.0.0:3847->3847/tcp' }];
    const warnings = controlDefaultPortWarnings(containers, 3847, 3848);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('har control up');
    expect(warnings[0]).toContain('3847');
    expect(warnings[0]).toContain('3848');
  });

  it('formats blocker message with har control up', () => {
    expect(formatControlPortBlocker('control-app-1', 3847, 'frontend')).toContain(
      'har control up (container "control-app-1")',
    );
  });
});

describe('inspectControlUpReadiness', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('warns when control harness slot 1 is active', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'har-control-up-'));
    tmpDirs.push(repo);
    const slotsDir = path.join(repo, 'control', '.har', 'slots');
    fs.mkdirSync(slotsDir, { recursive: true });
    fs.writeFileSync(
      path.join(slotsDir, 'agent-1.json'),
      JSON.stringify({
        version: 1,
        agentId: 1,
        projectName: 'control',
        mode: 'worktree',
        workDir: '/tmp/wt',
        createdAt: new Date().toISOString(),
        status: 'active',
      }),
    );

    const readiness = inspectControlUpReadiness(repo);
    expect(readiness.harnessSlot1Active).toBe(true);
    expect(readiness.warnings.some((w) => w.includes('harness slot 1'))).toBe(true);
  });
});

describe('inspectSlotReadiness control conflicts', () => {
  const tmpDirs: string[] = [];

  function makePm2Harness(feBase = 59700): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-preflight-pm2-'));
    tmpDirs.push(dir);
    const harDir = path.join(dir, '.har');
    fs.mkdirSync(harDir, { recursive: true });
    fs.writeFileSync(
      path.join(harDir, 'harness.env'),
      [
        'export HARNESS_PROJECT_NAME=control',
        `export HARNESS_FE_BASE_PORT=${feBase}`,
        `export HARNESS_API_BASE_PORT=${feBase}`,
        'export HARNESS_PORT_STEP=10',
        'export HARNESS_AGENT_SLOT_MIN=1',
        'export HARNESS_AGENT_SLOT_MAX=3',
      ].join('\n') + '\n',
    );
    fs.writeFileSync(
      path.join(harDir, 'ecosystem.agent.template.cjs'),
      'module.exports = { apps: [] };',
    );
    return dir;
  }

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('blocks when har control up occupies the allocated port', () => {
    const repo = makePm2Harness();
    const defaultPort = 59710;
    const readiness = inspectSlotReadiness(repo, 1, {
      pm2Processes: [],
      dockerContainers: [{ name: 'control-app-1', ports: `0.0.0.0:${defaultPort}->${defaultPort}/tcp` }],
    });
    expect(readiness.canLaunch).toBe(false);
    const conflict = readiness.blockers.find((b) => b.code === 'control_port_conflict');
    expect(conflict).toBeDefined();
    expect(conflict?.message).toContain('har control up');
    expect(readiness.remediations).toContain('har control down');
  });

  it('warns when har control up holds default but alternate port is allocated', async () => {
    const repo = makePm2Harness();
    const defaultPort = 59710;
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(defaultPort, '127.0.0.1', () => resolve());
    });
    try {
      const readiness = inspectSlotReadiness(repo, 1, {
        pm2Processes: [],
        dockerContainers: [
          { name: 'control-app-1', ports: `0.0.0.0:${defaultPort}->${defaultPort}/tcp` },
        ],
      });
      expect(readiness.canLaunch).toBe(true);
      expect(readiness.ports?.frontend).toBe(defaultPort + 1);
      expect(readiness.warnings?.some((w) => w.includes('har control up'))).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
