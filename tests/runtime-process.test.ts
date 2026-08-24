import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ExecFn } from '../src/runtime/exec';
import {
  deleteAgentProcesses,
  generateEcosystemConfig,
  pm2DeleteRegex,
  pm2SlotPrefix,
  renderTemplate,
  runReadinessIfConfigured,
  startAgentProcesses,
  tmuxSessionName,
  waitForHealthCheck,
} from '../src/runtime/process';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'har-runtime-process-'));
}

function mockExec(responses: Array<{ match: (cmd: string) => boolean; stdout?: string; code?: number }> = []) {
  const calls: Array<{ line: string; cwd?: string }> = [];
  const exec: ExecFn = (command, args, options) => {
    const line = [command, ...args].join(' ');
    calls.push({ line, cwd: options?.cwd });
    const hit = responses.find((r) => r.match(line));
    return { stdout: hit?.stdout ?? '', code: hit?.code ?? 0 };
  };
  return { exec, calls };
}

describe('PM2 naming formulas (byte-compatible with agent-slot.sh)', () => {
  it('matches har_pm2_slot_prefix / har_pm2_delete_regex / har_tmux_session', () => {
    expect(pm2SlotPrefix('myapp', 3)).toBe('har-myapp-agent-3');
    expect(pm2DeleteRegex('myapp', 3)).toBe('/^har-myapp-agent-3-/');
    expect(tmuxSessionName('myapp', 3)).toBe('har-myapp-agent-3');
  });
});

describe('renderTemplate (envsubst equivalent)', () => {
  it('substitutes ${VAR} and $VAR only for provided keys', () => {
    const out = renderTemplate('a=${AGENT_ID} b=$AGENT_ID c=${OTHER} d=$OTHER', { AGENT_ID: '7' });
    expect(out).toBe('a=7 b=7 c=${OTHER} d=$OTHER');
  });

  it('leaves JS template literals with unknown vars intact', () => {
    const template = 'const p = path.resolve(__dirname, `.env.agent.${AGENT_ID}`); const q = `${env.PORT}`;';
    expect(renderTemplate(template, { AGENT_ID: '2' })).toBe(
      'const p = path.resolve(__dirname, `.env.agent.2`); const q = `${env.PORT}`;',
    );
  });

  it('produces the same bytes as envsubst on the launch.sh variable list', () => {
    const template = [
      '// Agent ${AGENT_ID} for ${HARNESS_PROJECT_NAME}',
      'const fePort = ${FE_PORT};',
      'const debugPort = ${DEBUG_PORT};',
      'const untouched = `${process.env.HOME}`;',
      '',
    ].join('\n');
    const vars = { AGENT_ID: '4', HARNESS_PROJECT_NAME: 'proj', FE_PORT: '3040', DEBUG_PORT: '9240' };
    let expected: string;
    try {
      expected = execSync(`envsubst '\${AGENT_ID} \${HARNESS_PROJECT_NAME} \${FE_PORT} \${DEBUG_PORT}'`, {
        input: template,
        encoding: 'utf8',
        env: { ...process.env, ...vars },
      });
    } catch {
      return; // envsubst not installed — formula covered by the cases above
    }
    expect(renderTemplate(template, vars)).toBe(expected);
  });
});

describe('generateEcosystemConfig', () => {
  it('writes ecosystem.agent.<id>.config.cjs next to the work dir', () => {
    const workDir = tmpDir();
    const templatePath = path.join(workDir, 'ecosystem.agent.template.cjs');
    fs.writeFileSync(
      templatePath,
      'module.exports = { name: "har-${HARNESS_PROJECT_NAME}-agent-${AGENT_ID}-web", port: ${FE_PORT}, debug: ${DEBUG_PORT} };\n',
    );
    const configPath = generateEcosystemConfig({
      workDir,
      agentId: 2,
      projectName: 'proj',
      fePort: 3020,
      debugPort: 9220,
      templatePath,
    });
    expect(configPath).toBe(path.join(workDir, 'ecosystem.agent.2.config.cjs'));
    expect(fs.readFileSync(configPath, 'utf8')).toBe(
      'module.exports = { name: "har-proj-agent-2-web", port: 3020, debug: 9220 };\n',
    );
  });
});

describe('PM2 lifecycle', () => {
  it('startAgentProcesses deletes stale processes, starts, then saves', () => {
    const { exec, calls } = mockExec();
    startAgentProcesses({
      projectName: 'proj',
      agentId: 1,
      pkgExecPrefix: ['npx'],
      exec,
      workDir: '/work',
      ecosystemFile: '/work/ecosystem.agent.1.config.cjs',
    });
    expect(calls.map((c) => c.line)).toEqual([
      'npx pm2 delete /^har-proj-agent-1-/',
      'npx pm2 start /work/ecosystem.agent.1.config.cjs',
      'npx pm2 save --force',
    ]);
    expect(calls[1].cwd).toBe('/work');
  });

  it('startAgentProcesses throws when pm2 start fails', () => {
    const { exec } = mockExec([{ match: (c) => c.includes('pm2 start'), code: 1 }]);
    expect(() =>
      startAgentProcesses({
        projectName: 'proj',
        agentId: 1,
        exec,
        workDir: '/work',
        ecosystemFile: '/work/eco.cjs',
      }),
    ).toThrow('pm2 start failed');
  });

  it('deleteAgentProcesses is project-scoped', () => {
    const { exec, calls } = mockExec([{ match: () => true, code: 1 }]);
    expect(() => deleteAgentProcesses({ projectName: 'other', agentId: 9, exec })).not.toThrow();
    expect(calls[0].line).toBe('npx pm2 delete /^har-other-agent-9-/');
  });
});

describe('waitForHealthCheck', () => {
  it('passes as soon as the endpoint returns 200', async () => {
    const logs: string[] = [];
    const statuses = [0, 500, 200];
    const ok = await waitForHealthCheck({
      apiPort: 8010,
      healthCheckPath: '/health',
      agentId: 1,
      log: (m) => logs.push(m),
      httpStatus: async () => statuses.shift() ?? 200,
      sleep: async () => undefined,
    });
    expect(ok).toBe(true);
    expect(logs).toEqual(['Waiting for health check at http://localhost:8010/health...', 'Health check passed!']);
  });

  it('warns with the launch.sh lines after the 60s timeout', async () => {
    const logs: string[] = [];
    let slept = 0;
    const ok = await waitForHealthCheck({
      apiPort: 8010,
      healthCheckPath: '/health',
      agentId: 3,
      log: (m) => logs.push(m),
      httpStatus: async () => 503,
      sleep: async (s) => {
        slept += s;
      },
    });
    expect(ok).toBe(false);
    expect(slept).toBe(60);
    expect(logs[logs.length - 2]).toBe('Warning: Health check did not pass within 60s.');
    expect(logs[logs.length - 1]).toBe('Check logs: ./.har/agent-cli.sh 3 logs');
  });

  it('is a no-op without HARNESS_HEALTH_CHECK_PATH', async () => {
    const ok = await waitForHealthCheck({
      apiPort: 8010,
      agentId: 1,
      httpStatus: async () => {
        throw new Error('should not be called');
      },
    });
    expect(ok).toBe(true);
  });
});

describe('runReadinessIfConfigured', () => {
  it('skips with the agent-slot.sh message when unset', () => {
    const { exec, calls } = mockExec();
    const logs: string[] = [];
    const code = runReadinessIfConfigured({}, 1, { exec, log: (m) => logs.push(m) });
    expect(code).toBe(0);
    expect(calls).toHaveLength(0);
    expect(logs).toEqual(['No HARNESS_READINESS_CMD configured; skipping readiness smoke.']);
  });

  it('substitutes {agentId} and runs through bash', () => {
    const { exec, calls } = mockExec();
    runReadinessIfConfigured({ HARNESS_READINESS_CMD: 'curl -s http://localhost:80{agentId}0/ready' }, 2, {
      exec,
      log: () => undefined,
    });
    expect(calls[0].line).toBe('bash -c curl -s http://localhost:8020/ready');
  });
});
